<!-- OWNER: WP1 — the supported import schema (SPEC §5, §7.1, §12.1); kept in step with server/ingest/* -->
# Importing your own files into Scrolls

Scrolls imports **TXT, Markdown, CSV, TSV, JSON and JSON Lines** files into collections of your own (corpus
`user`). Everything happens on this computer: the file is stored unchanged in your data folder
(`$SCROLLS_DATA/originals/<sha256[0:2]>/<sha256>`), parsed, mapped onto Scrolls' document fields, checked in a
dry run, and only then written. Every passage keeps offsets into the original text, so every count can be
opened back to the words it came from.

- [1. The four steps](#1-the-four-steps) · [2. Formats](#2-formats) · [3. The mapping](#3-the-mapping) ·
  [4. Dates](#4-dates) · [5. Citations and relations](#5-citations-and-relations) · [6. What is kept](#6-what-is-kept) ·
  [7. Duplicates](#7-duplicates) · [8. Problems and what to do](#8-problems-and-what-to-do) ·
  [9. The import summary](#9-the-import-summary) · [10. Limits and what is not built yet](#10-limits-and-what-is-not-built-yet) ·
  [11. Examples](#11-examples)

## 1. The four steps

The wizard (right panel "Import", or drop a file anywhere on the page) and the API follow the same steps.

| Step | Wizard | API |
|---|---|---|
| 1 Upload | drop or choose a file; name the collection; see format, encoding, delimiter and 20 sample rows | `POST /api/imports` — raw body (`Content-Type: application/octet-stream`), headers `X-Scrolls-Filename` (URL-encoded) and `X-Scrolls-Collection` (URL-encoded JSON `{"slug","name","unit","license"}`, optional) → `{import_batch_id, preview}` |
| | change how the file is read | `GET /api/imports/:id/preview?format=&delimiter=comma\|tab\|semicolon\|pipe&header=0\|1&encoding=utf-8\|windows-1252&pointer=/items&line_mode=1` |
| 2 Map | each target pre-filled from header synonyms and the values; a live check of the dates on the sample rows | (client side) |
| 3 Validate | a dry run over **every** row; the projected summary; nothing is written | `PUT /api/imports/:id/mapping {mapping}` → `{validation: ImportSummary}` (runs in the read-only worker pool) |
| 4 Commit | a job with progress, then the summary and **Open in timeline** | `POST /api/imports/:id/commit {mapping}` → `{job: {id}}`; follow `GET /api/jobs/:id/events` (SSE) or `GET /api/jobs/:id`; the job's `result` is the ImportSummary |
| problems | **Download every problem (CSV)** | `GET /api/imports/:id/problems.csv` — the commit's issues, or those of the latest dry run |
| undo | **Undo this import…** | `POST /api/imports/:id/revert` → `{job}`: the batch's documents are soft-deleted and `data_version` is bumped |

Mutating requests from scripts need `Origin: http://127.0.0.1:<port>` (DNS-rebinding guard). Shapes:
`ImportCreated`, `ImportPreview`, `ImportValidation`, `ImportSummary`, `JobRef` in `src/shared/contracts.mjs`;
canned examples in `tests/contract/*imports*.json`.

A failed or cancelled commit leaves **zero** documents from the batch (the writer rolls the whole batch back);
its issues stay downloadable, and the batch can be committed again with a corrected mapping.

## 2. Formats

The format comes from the file extension (`.txt .text .md .markdown .csv .tsv .tab .json .jsonl .ndjson`),
otherwise from the content; the upload step can override it.

| Format | How it is read |
|---|---|
| **TXT** | One document per file; the whole file is the original text. Leading `Title:` / `Author:` / `Date:` / `Language:` lines (also `Year`, `Translator`, `Editor`, `Source`, `URL`, `License`, `Genre`, `Kind`, `Community`) followed by a blank line, or a `---` front-matter block, become metadata; the body starts after them. In a Project Gutenberg file the body is what lies between the `*** START OF … ***` and `*** END OF … ***` lines, so the licence is never counted as text (its "Release date" is kept as `release_date`, not as the work's date). Title defaults to the file name. |
| **Markdown** | Front matter (YAML subset: `key: value`, quoted values, inline lists `[a, b]`, `- item` lists, one level of indented `key: value`, `|`/`>` blocks) is metadata. Every ATX heading (`#` … `######`, outside fenced code) starts a new passage. The original keeps its markup; `#`, `*`, `_`, `>` and backticks are punctuation, never tokens. Title: front matter, else the first `# heading`, else the file name. |
| **CSV / TSV** | RFC 4180: quoted fields, newlines inside quotes, `""` escapes, CRLF/LF/CR line ends, a UTF-8 BOM. The delimiter (`,` tab `;` `|`) is chosen by field-count consistency over the first 50 records / 64 KB. A header row is required unless you untick "First row is a header" (columns are then `col1`, `col2`, …). A row with more fields than the header is rejected (`E_ROW_RAGGED`); a shorter one is padded with empty fields (`W_TRUNCATED_ROW`). Duplicate header names become `name (2)`. "Row N" in messages = the record that starts on line N. |
| **JSON** | An array of objects, or an object whose array of records you choose by JSON Pointer (`/items`, `/data/rows`); with no pointer the largest array of objects is taken and named in an info issue. Nested values are reachable as pointer columns (`/meta/year`). A syntax error anywhere makes the file unreadable (`E_JSON_PARSE` with line and column) — JSON Lines avoids that. |
| **JSON Lines** | One object per line; blank lines skipped; a bad line is rejected alone (`E_JSON_PARSE`, line and column). Array values (e.g. `pages`) are joined into the text: paragraphs (`\n\n`) by default, or with `join(\f)` so pages keep their page numbers (as Cipher's Wikisource files do). |

**Encoding.** UTF-8 (a BOM is stripped and recorded). Bytes that are not valid UTF-8 are read as Windows-1252
with `W_ENCODING_FALLBACK` naming the first bad byte, its offset and its line; choose "UTF-8, strict" to refuse
instead (`E_ENCODING`). UTF-16 files, ZIP containers (.xlsx, .docx, .epub), PDFs and binary files are refused
with a message saying what to export instead. Nothing is normalized: offsets are UTF-16 code units into the
decoded original (SPEC D4).

## 3. The mapping

```json
{ "format": "csv", "delimiter": ",", "header": true, "encoding": "utf-8",
  "collection": { "slug": "my-zines", "name": "Zines 1977–1999", "unit": "tokens", "license": "own" },
  "fields": {
    "ext_id":   { "from": "id" },
    "title":    { "from": "Title", "transform": ["trim"] },
    "text":     { "from": "body" },
    "date":     { "from": "issued", "transform": [{ "date": { "circa_radius": 5, "two_digit_century": null } }] },
    "language": { "from": "lang", "transform": [{ "map": { "English": "en", "Hindi": "hi" } }] },
    "community":{ "const": "east-side zine scene" },
    "cites":    { "from": "refs", "transform": [{ "split": ";" }] },
    "meta.shelf": { "from": "box" } },
  "options": { "dedupe": "flag", "detect_language": true, "on_bad_row": "skip_and_report", "line_mode": false } }
```

**Collection.** `slug` (lower-case letters, digits, hyphens; files with the same slug share a collection),
`name`, `unit` — `tokens` for texts (rates per million tokens) or `works` for title lists (rates per 1,000
works) — and `license`. A slug that belongs to the demo, Cipher or STEMM corpus is refused
(`E_COLLECTION_NOT_USER`).

**Sources.** `{"from": "<column>"}` — a CSV header, a JSON key, a JSON Pointer inside the record (`/meta/year`),
or a 1-based column number; or `{"const": <value>}` for every row. `json` files also take a top-level
`"pointer"` (where the records are).

**Targets.**

| Target | Becomes | Notes |
|---|---|---|
| `text` | the document text (passages, tokens, search) | Without it a record is title-only (metadata). Over 20 MB → `E_ROW_TOO_LARGE`. |
| `title` | title (shown on marks; title search) | Title-only records are searchable by title. |
| `ext_id` | your id (unique per collection) | Empty or unmapped → generated: `<sha256[0:8]>#<n>` (n = record number), `<file-stem>-<sha256[0:8]>` for TXT/MD. |
| `author` | author / speaker / maker | Lists are joined with `; `. |
| `date` | publication/creation date = **chronology** | §4 below. |
| `date_end` | end of a range read with `date` | `1850` + `1855` → 1850–1855. |
| `date_precision` | widens the date to `day`, `month`, `year`, `decade`, `century` or `millennium` | Never narrows: "year" on 1850–1855 is refused with a warning. |
| `referenced_date` | the time the text is about | Its own assertion (role `referenced`), never chronology. |
| `language` | declared language | Names in en/fr/es/hi/gu (`English`, `हिन्दी`, `ગુજરાતી`, …), 2- or 3-letter codes, BCP-47 tags. Anything else is reported and ignored. Passages are still identified one by one; a text that reads as another language is marked a translation (`W_LANG_MISMATCH`). |
| `kind` | document kind (lower-cased) | Default `document`. |
| `genre`, `community`, `culture`, `field` | facets | `culture` = country of origin; `field` = STEMM field. |
| `source_url`, `license` | per record | |
| `cites` | documented `explicit_citation` links | §5. |
| `relations` | typed links | §5. |
| `tags` | catalogue tags (scheme `keyword`, provenance `documented_category`) | Not text: never counted as words. |
| `notes` | kept in the record's metadata | Not searched. |
| `meta.<name>` | kept under `original_meta.mapped.<name>` | Passthrough. |
| `collection` | — | **Not supported yet**: the value is kept in the record's metadata and every row goes into the mapping's collection (a stated warning). |

**Transforms** — a closed list, applied in order; in the wizard they are written as text:

| Transform | Text form | Effect |
|---|---|---|
| `"trim"` | `trim` | strip surrounding whitespace |
| `"lower"` | `lower` | lower-case |
| `{"split": ";"}` | `split(;)` | text → list (`\t`, `\n`, `\f` allowed) |
| `{"join": "; "}` | `join(; )` | list → text; `join(\f)` joins pages |
| `{"map": {"English": "en"}}` | `map(English=en; Spanish=es)` | replace values (exact, then case-insensitive); others unchanged |
| `{"regex_extract": {"pattern": "(\\d{4})", "group": 1}}` | `regex_extract(/(\d{4})/, 1)` | the group (default 1 if the pattern has one, else the whole match); no match → empty |
| `{"date": {…}}` | `date(circa_radius=5, two_digit_century=19)` | date options, §4 |
| `"zero_is_unknown"` | `zero_is_unknown` | a `0` date means unknown (undated), not year 0 |

**Options.** `dedupe`: `flag` (keep both, the later one flagged and excluded from counts by default), `skip`
(reject the later copy), `off`. `on_bad_row`: `skip_and_report` (default) or `abort` (the first rejected row
stops the import; nothing is kept). `detect_language`: identify each passage (default on). `line_mode`
(TXT/MD): every multi-line block becomes stanzas — for verse and transcripts.

**Suggestions.** The preview's `suggested_mapping` fills targets from header synonyms (English, French,
Spanish, Hindi, Gujarati: `date|year|published|issued|pub_date|fecha|तारीख|તારીખ`, `text|body|content|lyrics_excerpt|…`,
`title|name|titulo|titre|शीर्षक|નામ`, …), checked against the values (a "date" column whose values are not
dates is not suggested), then from the values themselves: > 80% parsing as dates → `date`; the longest
average string → `text`; distinct id-like values → `ext_id`; language names → `language` (with an explicit
`map`); web addresses → `source_url`. Each suggestion carries its `reason`, reported in the summary's
`mapping_decisions`.

## 4. Dates

Dates are read with the shared grammar of SPEC §5.3 (`src/shared/dates.mjs`): ISO days and months, named
months in en/fr/es/hi/gu, years, `c. 1931` (± `circa_radius`, default 5 years), decades (`1990s`, `années 1990`),
`the 1800s` (a whole century, with a warning), centuries (`19th century`, `XIXe siècle`, `siglo XIX`),
early/mid/late centuries, ranges (`1850–1855`, `1850-55`, `between … and …`), open ranges (`before 1850`,
`open_range_years` default 50), BCE, bare negative years (`negative_year_convention`: `historical` default or
`astronomical`), millennia, Vikram and Shaka Samvat, seasons (with a warning), Devanagari and Gujarati
digits, and `n.d.`, `s.d.`, `sin fecha`, `?`, empty → unknown. Two-digit decades (`'90s`) need
`two_digit_century` (`18`, `19` or `20`). A date after the import time is **announced** and goes to the
Scheduled shelf (`W_DATE_FUTURE`).

Centuries are read as people write them (fix pass): `19th century` = 1800–1899 (SPEC Appendix A), but `1st century` =
1–99 CE (year 0 is 1 BCE, which belongs to the 1st century BCE), and `5th century BCE` = 500–401 BCE. The Scroll's
century bins are astronomical (bin −5 = 501–402 BCE), so a stated BCE century never fits one century bin: it is a
precision wash at the century tier and finer, and counts in its millennium bin. CE centuries from the 2nd on fit their
bins.

A date that does not parse never stops a row: the row is imported **undated** (on the UNDATED shelf, outside
chronology), the raw value is kept on its date assertion (rule `unparsed`, with the reason), and the issue
suggests readings that do parse (`try 'spring 1850' (Mar–May 1850) or 'c. 1850'`).

Three kinds of time stay apart: chronology (`date`, `date_end`), referenced time (`referenced_date`), and
ingestion time (recorded automatically as a `date_assertion` with role `ingestion`; shown only in imports and
jobs).

## 5. Citations and relations

**`cites`** — ids of records this record cites (a list, or text split on `;` or `|`). Each becomes an
`explicit_citation` relationship from this record to the cited one, **documented** "as stated in your file":
`origin = source_dataset`, `source_dataset = "your import: <file>"`, `source_locator = sha256:<file sha>#line=<n>`
(a pointer into the stored original). A record citing its own id is ignored with a warning.

**`relations`** — typed links, as a list of objects `{"type": "samples", "target": "z001", "evidence": "documented"|"proposed", "collection": "…"}`
or as text `samples:z001; parody_of:z002:proposed`. `type` is one of the relationship types of SPEC §3.1
(`exact_quotation`, `samples`, `interpolates`, `explicit_citation`, `adaptation_of`, `cover_of`, `remix_of`,
`translation_of`, `parody_of`, `recontextualizes`, `answer_to`, `reframes`, `inspired_by`, `homage_to`,
`proposed_allusion`, `part_of`, …). `documented` (default) is a claim your file states; `proposed` is a
suggestion (origin `human`). A file cannot state a computed link, and similarity types (`kindred`,
`shared_wording`, `similar_contextual_usage`, …) are recorded as **proposed**, never documented: similarity
never establishes influence (SPEC §13 rule 6).

Targets are resolved after every row is read: an id of this file or of the collection, or in the `collection`
named on the relation. A namespaced id (`pg:1342`, `cw:4948` — letters, a colon, the rest) that is found in
neither may name a document elsewhere in Scrolls and is linked when exactly one document carries it; a plain id
(`z001`) is never looked up outside this file and collection, so a documented link cannot land on an unrelated
record that happens to share a short id. An unknown target is reported (`W_UNRESOLVED_TARGET`) and no link is
created.

## 6. What is kept

- **The file**, byte for byte, content-addressed by its sha256 (`original_file`), with the batch that read it.
- **Each record's text** exactly as decoded (`document_text.original`; TXT/MD: the whole file with the body
  bounds), and each record's byte range in the file (`source_file`).
- **Every column**, mapped or not, in `original_meta.record` (the text column replaced by a pointer
  `{"$text": "document text", "chars": n}`), plus `file`, `line`, `notes` and `mapped` (`meta.*`).
- **The mapping** (`import_batch.mapping_json`), the projected or final summary (`summary_json`), every issue
  (`import_issue`), and an analysis run (`stage = import`) with the code and mapping hashes.

## 7. Duplicates

1. The same file (sha256) already committed to the collection → the import is refused (`E_DUP_FILE`, at
   upload when the collection is named, else at the dry run and the commit). Importing it into another
   collection is allowed.
2. The same `ext_id` twice in one file → the later row is rejected (`E_DUP_ID` citing both lines); an id that
   exists in the collection already (an earlier import, also a reverted one: documents are only soft-deleted)
   → rejected, naming that batch.
3. The same text (folded tokens) as an existing document → accepted, flagged `dup_of`, excluded from counts by
   default (`W_DUP_CONTENT`); `dedupe: skip` rejects it instead.
4. Nearly the same text (whole-document MinHash Jaccard ≥ 0.9, 128 permutations over 5-token shingles) →
   accepted with `W_NEAR_DUP`.
5. A title-only record with the same folded title, author and year as another → `W_DUP_METADATA`.

## 8. Problems and what to do

Every issue is `{code, severity, line, col, field, value_excerpt, message, suggestion}`; the suggestion is
never empty. `severity`: `info` (nothing to do), `warning` (row kept), `rejected` (row skipped), `fatal`
(the import is refused; zero documents).

| Code | Severity | Example message → what to do |
|---|---|---|
| `E_ENCODING` | fatal | "Line 418: bytes are not valid UTF-8 (0xE9 at byte 30,211)." / "This file is UTF-16 text…" → re-save as UTF-8, or choose the Windows-1252 reading |
| `W_ENCODING_FALLBACK` | warning | "Line 418: bytes are not valid UTF-8 (0xE9 at byte 30,211); read as Windows-1252." → re-save as UTF-8, or accept the reading shown |
| `E_CSV_QUOTE` | fatal | "An unclosed quote starts on line 77, column 14 and runs to the end of the file." → check for a stray `"` in the named column |
| `E_ROW_RAGGED` | rejected | "Row 57 has 9 fields, the header has 8." → check for an unquoted comma in the named column |
| `W_TRUNCATED_ROW` | warning | "Row 5 has 2 fields, the header has 3; missing fields are empty." |
| `E_JSON_PARSE` | rejected (JSONL) / fatal (JSON) | "Line 7, column 49: expected ',' or '}' after property value (found '\"')." |
| `E_MISSING_TEXT` | rejected | "Row 55 has no text and no title." → map a text column or a title |
| `E_DATE_UNPARSEABLE` | warning | "Row 9 date 'Spring-ish 1850' was not recognised; row imported as undated." → try 'spring 1850' (Mar–May 1850) or 'c. 1850' |
| `E_DATE_AMBIGUOUS` | warning | "Row 3 date ''90s': which century? Set 'two-digit years → 19xx'. Row imported as undated." |
| `E_DATE_INVALID` | warning | "Row 21 date 2019-02-30 does not exist; row imported as undated." |
| `E_FIELD_TYPE` | warning | "Row 12 'cites' is an object; expected a list of ids. The field was ignored." (also: unknown language, unknown relation type, precision not applied, a record that is not an object) |
| `E_ROW_TOO_LARGE` | rejected / fatal | "Row 4 text is 31 MB (limit 20 MB)." → split the text into parts; or more than 5,000,000 records |
| `E_DUP_FILE`, `E_DUP_ID` | fatal / rejected | §7 |
| `W_LANG_MISMATCH` | warning | "Declared fr, but the text reads as en (…). Marked as a translation." |
| `W_MIXED_LANGUAGE` | info | "Document 'Aarti Sangrah' has passages in hi (71%) and sa (29%)." |
| `W_DATE_FUTURE`, `W_AMBIGUOUS_HUNDREDS`, `W_DATE_SEASON` | info / warning | the reading that was used |
| `W_DUP_CONTENT`, `W_NEAR_DUP`, `W_DUP_METADATA` | warning | §7 |
| `W_UNRESOLVED_TARGET` | warning | "Relationship explicit_citation: target 'z999' was not found; the link was not created." |

`problems.csv` columns: `code,severity,line,col,field,value_excerpt,message,suggestion`.

## 9. The import summary

The dry run and the commit return the same object (SPEC §5.7; shape `ImportSummary`): `rows` (seen, accepted,
accepted_with_warnings, rejected — accepted + rejected = seen; "with warnings" counts accepted rows with at
least one `warning`), `documents` (created, duplicates_flagged, near_duplicates, metadata_only, translations),
`passages`, `tokens`, `dates` (documents by precision, `circa`, `unknown` = undated, `scheduled`, and the span),
`languages` (documents by detected language), `relationships` (documented, proposed, unresolved_targets),
`mapping_decisions` (target, column, transforms, date parse rate, reason), `problems` (counts by code, the first
20, the download link), and `data_version`, `run_id`, timings. Additive fields: `projected` (true for a dry
run), `status`, `fatal`, `aborted` (where `on_bad_row: abort` stops), `notes`.

The dry run runs the writer's own segmentation, tokenization and language identification, so its counts are
the commit's. Two things can differ: near duplicates are projected only for files up to 15 M characters
(stated in `notes`), and the database may change between the dry run and the commit.

## 10. Limits and what is not built yet

- **2 GB per upload**, streamed to disk. CSV, TSV and JSON Lines files over 64 MB are read **in chunks**
  (16 MB at a time; the encoding is checked over the whole file first), so they import up to 2 GB; their
  preview shows the first 4 MB and says so. JSON, TXT and Markdown are read whole, up to 400 MB (save large
  JSON as JSON Lines). 20 MB of text per record (a TXT or Markdown file is one record); 5,000,000 records per
  import. A dry run reads about 10 MB/s (a 50 MB CSV in ≈ 5 s; 2 GB in a few minutes, with a timeout scaled
  to the file).
- Very large commits: DocumentWriter keeps each new document's MinHash signature in memory for the
  near-duplicate check (about 0.5 KB per document), so a multi-million-row file is best imported with
  duplicates set to "do not check".
- **Per-row collections** (`collection` target) are not supported: one import = one collection.
- **Mapping reuse**: the preview lists up to five earlier validated or committed imports whose columns are the
  same (`previous_mappings`); the wizard applies their fields and options in step 2 (the collection stays the
  one chosen in step 1).
- PDF, EPUB and spreadsheets: export them as TXT, CSV or JSON first.
- Markdown link targets and image URLs are part of the text and are tokenized like other words.
- Reverting soft-deletes documents; their ids stay taken in that collection (import corrected records into a
  new collection).

## 11. Examples

CSV (`letters.csv`): `letter_id,title,author,written,language,body,cites` — suggested: `ext_id ← letter_id`,
`title ← title`, `author ← author`, `date ← written`, `language ← language` (`map(English=en; Hindi=hi)`),
`text ← body`, `cites ← cites` (`split(;)`).

JSON Lines with pages:

```json
{"id": "p1", "title": "Paged ledger", "pages": ["Page one: carry the zero.", "Page two: the sum holds."], "date": "1930", "lang": "en"}
```

mapping `"text": {"from": "pages", "transform": [{"join": "\f"}]}` keeps page numbers on the passages.

Markdown:

```markdown
---
title: "Zero, a Field Guide"
author: Mireille Fixture (synthetic)
date: c. 1894
language: en
tags: [zero, primer]
---
# Zero, a Field Guide
…
## In the classroom
…
```

→ one document dated c. 1894 (1889–1899), one passage group per heading section.
