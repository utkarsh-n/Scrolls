<!-- OWNER: WP0 -->
# Mini corpus — 12 test documents (en · fr · es · hi · gu)

The texts are **invented for tests** (not real works, not quotations). Every author carries "(synthetic)"; if
these documents are ever loaded outside a temporary test database, load them into a synthetic corpus so they
are labelled as such (SPEC §13 rule 1). Tests seed them through `tests/helpers/tmpdata.mjs` (SPEC §11).

| File | What it is |
|---|---|
| `documents.jsonl` | 12 `CanonicalDocument` objects (SPEC §12.3), one per line, ready for `DocumentWriter.addDocument`. Dates carry `raw` only — the writer parses them with `src/shared/dates.mjs`. |
| `expected.json` | Machine-readable expectations: per document the chronology `parseDate(raw)` must give (`now` = 2026-10-04), body length / token count / folded `norm` / blank-line paragraph offsets, probe offsets, metadata field token counts, corpus-wide token counts, the shared 13-token run and phrase hits. |

`tests/dates.test.mjs` and `tests/tokenize.test.mjs` re-derive every number in `expected.json` (dates, offsets,
token counts, FTS5 parity), so the file cannot drift from the shared modules unnoticed.

## Documents and dates

| ext_id | lang | kind | title | date as written | rule · precision · basis | years | lo_day…hi_day | label | status | body length · tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| `mini:01` | en | book | The Counting House | `1903` | year · year · stated | 1903–1903 | -24472…-24108 | 1903 | dated | 335 · 61 |
| `mini:02` | en | memo | Ledger Memo | `1958-03-14` | iso_day · day · stated | 1958–1958 | -4311…-4311 | 14 Mar 1958 | dated | 309 · 50 |
| `mini:03` | en | bulletin | Bench Bulletin No. 7 | `June 1963` | month · month · stated | 1963–1963 | -2406…-2377 | Jun 1963 | dated | 279 · 51 |
| `mini:04` | fr | essay | Le zéro qui garde la place | `années 1890` | decade · decade · stated | 1890–1899 | -29219…-25568 | 1890s | dated | 254 · 51 |
| `mini:05` | fr | letter | Lettre sur la retenue | `vers 1894` | circa · range · estimated | 1889–1899 | -29584…-25568 | c. 1894 | dated | 145 · 26 |
| `mini:06` | es | poem | El cero que se lleva | `7 de abril de 1931` | dmy_named · day · stated | 1931–1931 | -14149…-14149 | 7 Apr 1931 | dated | 180 · 36 |
| `mini:07` | es | notebook | Cuaderno de pingüinos | `principios del siglo XX` | century_part · range · stated | 1900–1933 | -25567…-13150 | early 20th century | dated | 133 · 22 |
| `mini:08` | hi | verse | शून्य का पाठ | `शक 1850` | shaka_samvat · range · derived | 1928–1929 | -15341…-14611 | 1928–1929 (Saka 1850) | dated | 132 · 30 |
| `mini:09` | hi | book | गिनती की किताब | `१९७१` | year · year · stated | 1971–1971 | 365…729 | 1971 | dated | 121 · 24 |
| `mini:10` | gu | book | ગણિત પોથી | `સંવત ૧૯૮૭` | vikram_samvat · range · derived | 1930–1931 | -14610…-13881 | 1930–1931 (VS 1987) | dated | 107 · 20 |
| `mini:11` | gu | song | શૂન્ય ગીત | `n.d.` | unknown · unknown · unknown | — | — | undated | undated | metadata only |
| `mini:12` | en | film | Zero Hour ◉ 🎬 | `2090` | year+future · year · announced | 2090–2090 | 43830…44194 | 2090 | scheduled | metadata only |

`mini:02` also has a `referenced` date `1911` (not chronology). `mini:11` and `mini:12` are metadata-only
(`fields.title` + `fields.summary`, `field_roles.summary = 'describes'`), like Cipher culture works.

What the bodies exercise (offsets are UTF-16 code units into `text.original`, SPEC D4):

- `mini:01` Gutenberg-style `_italics_`, long s `ſ` (JS keeps `ſaid`; FTS folds it to `said`), a proper-noun-guard
  pair (`Gene Halloran` vs `selfish gene`).
- `mini:02` **CRLF** line endings, a curly apostrophe, a `referenced` date; shares an exact **13-token run** with `mini:03`.
- `mini:03` `◉` (U+25C9, So), an emoji with a skin-tone modifier (`👍🏽` → token `👍`; U+1F3FD is Sk, not a token),
  a soft hyphen inside `co­operative` (one token, `cooperative`), `Dr. Varn` (not sentence-initial).
- `mini:04` NBSP before French punctuation, `l’école` (apostrophe splits), `œ`, `ç`, and a **decomposed** `écrivaient`
  (folds to NFC `écrivaient`).
- `mini:05` circa date, `Étienne` (capital accented initial).
- `mini:06` `¿…?` `¡…!`, `ñ`, digits.
- `mini:07` `ü`, digits, century-part date.
- `mini:08` Devanagari matras, precomposed nukta `क़` (NFC decomposes it), Devanagari digits `४२` (→ `42`),
  ZWJ inside `क्‍षण` and ZWNJ inside `ज़ि‌द` (each one token), danda `।` and double danda `॥`, Saka date.
- `mini:09` pages joined with `\f` (`decoder: 'pages-joined-ff'`), chandrabindu `ँ`, Devanagari-digit date.
- `mini:10` Gujarati matras and digits `૧૨` (→ `12`), Vikram Samvat date in Gujarati digits.

## Probes

| ext_id | probe (exact substring of `text.original`) | start | end | folded norm | token index |
|---|---|---|---|---|---|
| `mini:01` | `ghost in the margin` | 60 | 79 | `ghost in the margin` | 11 |
| `mini:01` | `ſaid` | 130 | 134 | `ſaid` | 25 |
| `mini:01` | `Gene Halloran` | 226 | 239 | `gene halloran` | 43 |
| `mini:01` | `selfish gene` | 275 | 287 | `selfish gene` | 51 |
| `mini:01` | `zero` | 164 | 168 | `zero` | 31 |
| `mini:02` | `Carry the zero` | 36 | 50 | `carry the zero` | 4 |
| `mini:02` | `auditors’` | 186 | 195 | `auditors` | 31 |
| `mini:02` | `carrying zeros` | 230 | 244 | `carrying zeros` | 37 |
| `mini:02` | `it holds the place where nothing is, so that something can be counted` | 62 | 131 | `it holds the place where nothing is so that something can be counted` | 8 |
| `mini:03` | `it holds the place where nothing is, so that something can be counted` | 38 | 107 | `it holds the place where nothing is so that something can be counted` | 7 |
| `mini:03` | `◉` | 148 | 149 | `◉` | 27 |
| `mini:03` | `👍` | 187 | 189 | `👍` | 34 |
| `mini:03` | `co­operative` | 196 | 208 | `cooperative` | 36 |
| `mini:03` | `Varn` | 241 | 245 | `varn` | 43 |
| `mini:04` | `zéro` | 3 | 7 | `zéro` | 1 |
| `mini:04` | `écrivaient` | 126 | 137 | `écrivaient` | 24 |
| `mini:04` | `cœur` | 195 | 199 | `cœur` | 38 |
| `mini:04` | `leçon` | 206 | 211 | `leçon` | 41 |
| `mini:05` | `zéro` | 34 | 38 | `zéro` | 8 |
| `mini:05` | `Étienne` | 136 | 143 | `étienne` | 25 |
| `mini:05` | `gardé` | 116 | 121 | `gardé` | 22 |
| `mini:06` | `cero` | 3 | 7 | `cero` | 1 |
| `mini:06` | `ceros` | 40 | 45 | `ceros` | 8 |
| `mini:06` | `niño` | 63 | 67 | `niño` | 12 |
| `mini:06` | `Muñoz` | 133 | 138 | `muñoz` | 27 |
| `mini:06` | `1931` | 174 | 178 | `1931` | 35 |
| `mini:07` | `pingüino` | 13 | 21 | `pingüino` | 2 |
| `mini:07` | `42` | 52 | 54 | `42` | 8 |
| `mini:07` | `cigüeña` | 59 | 66 | `cigüeña` | 10 |
| `mini:07` | `margen` | 125 | 131 | `margen` | 21 |
| `mini:08` | `शून्य को साथ ले चल` | 14 | 32 | `शून्य को साथ ले चल` | 3 |
| `mini:08` | `क़लम` | 71 | 74 | `क़लम` (decomposed nukta) | 16 |
| `mini:08` | `४२` | 83 | 85 | `42` | 19 |
| `mini:08` | `क्‍षण` | 95 | 100 | `क्षण` | 22 |
| `mini:08` | `ज़ि‌द` | 107 | 112 | `ज़िद` | 25 |
| `mini:09` | `शून्य` | 39 | 44 | `शून्य` | 8 |
| `mini:09` | `चाँद` | 76 | 80 | `चाँद` | 15 |
| `mini:09` | `गिनते` | 110 | 115 | `गिनते` | 22 |
| `mini:10` | `શૂન્ય ઉપાડો` | 11 | 22 | `શૂન્ય ઉપાડો` | 2 |
| `mini:10` | `૧૨` | 55 | 57 | `12` | 10 |
| `mini:10` | `ગુજરાતી` | 68 | 75 | `ગુજરાતી` | 13 |
| `mini:10` | `નિશાળમાં` | 76 | 84 | `નિશાળમાં` | 14 |

`start`/`end` delimit the probe substring as written (so `auditors’` includes the apostrophe, which is not part of
the token); `token index` is the index of the probe's first token in `tokenize(text.original)`.

## Corpus-wide expectations (bodies only, exact folded tokens, no variants)

| token | documents (count) |
|---|---|
| `zero` | mini:01 (1), mini:02 (1), mini:03 (1) |
| `zéro` | mini:04 (3), mini:05 (2) |
| `cero` | mini:06 (3) |
| `शून्य` | mini:08 (2), mini:09 (1) |
| `શૂન્ય` | mini:10 (1) |
| `◉` | mini:03 (1) |
| `carry` | mini:02 (1), mini:03 (1) |

The phrase `carry the zero` occurs in `mini:02` and `mini:03`; the 13-token run `it holds the place where nothing is
so that something can be counted` is shared verbatim by `mini:02` (token 8) and `mini:03` (token 7). Passage
boundaries are not listed: they belong to `server/text/segment.mjs`; `expected.json` gives blank-line paragraph
offsets (`body.paragraphs`) for orientation only.
