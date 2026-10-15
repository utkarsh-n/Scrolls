<!-- OWNER: WP1 -->
# Ingest fixtures (all invented for tests)

Every text, title and name here is **invented** (authors end in "(synthetic)"); tests load them only into
temporary databases. None is a quotation of a real work (SPEC §13 rule 1).

| File | Exercises | Expected (asserted by tests) |
|---|---|---|
| `letters.csv` | UTF-8 BOM, CRLF, quoted fields with an embedded newline and `""` escapes, a citation column, Devanagari rows (`अनुपम`), one ragged row (line 40), one unparseable and one ambiguous date | rows seen 38 · accepted 37 · with warnings 2 · rejected 1 |
| `semicolon.csv` | `;` delimiter (sniffed), a Hindi header (`शीर्षक` → title), a quoted field containing `;` | 5 accepted |
| `gujarati.tsv` | tab delimiter, a Gujarati header (`તારીખ` → date), Vikram Samvat date in Gujarati digits, `ગુજરાતી` | 4 accepted |
| `records.json` | one object whose records sit at `/items`; nested `meta.year` (`/meta/year` column), lists, a cited id | 4 accepted (one title-only) |
| `records.jsonl` | JSON Lines with `pages` arrays, a blank line, a broken line 4 | 3 accepted · 1 rejected (E_JSON_PARSE, line 4) |
| `note.txt` | Gutenberg-style `Title:/Author:/Date:/Language:` header lines | 1 document dated 1903 |
| `essay.md` | YAML front matter (inline list), ATX headings that start passages, Gujarati paragraph | 1 document dated c. 1894 |

`harness.mjs` stages a file the way `POST /api/imports` does (stored original + batch + preview) and runs the
dry run and the commit job body without an HTTP server. Malformed inputs (invalid UTF-8, ragged row 57,
an unclosed quote on line 77, a JSONL error on line 7, a 31 MB field…) are generated inside
`tests/ingest.malformed.test.mjs` so their line numbers are exact.
