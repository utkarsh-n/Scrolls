<!-- OWNER: N0 — golden families, rules, the regeneration log (sections per tier owner) -->
# Differential testing

## N0 · the golden harness (N0a, 2026-10-10)

### Generating

```
Tools/golden.sh [g1.core | <family>,… | all]            # mirror → node Golden/run.mjs (serialised by a lock)
node Golden/run.mjs --families <list> --out ~/Developer/scrolls-golden/<ref> [--ref <commit>]
     [--commit-subset ScrollsKit/Tests/DifferentialTests/Golden] [--native <Native>] [--snapshots <dir>] [--no-generate] [--list]
```

- **Modules.** `run.mjs` imports every `Golden/gen-*.mjs`. A module exports `families = { name: async (ctx) => cases }`
  (or `{ run, private, owner, attribution, note }`), optionally `group` (selects all its families: `g1.core` is
  gen-core's) and `generate(ctx)` (generated sources). A family returns an array of cases; each case becomes one line of
  `<family>/cases-NNNN.jsonl` (≤ 2,000 cases or 8 MB per file), strings made well-formed (a lone surrogate → U+FFFD,
  which is what a Swift String holds).
- **ctx.** `ref`, `refRoot` (the Node reference the mirror holds), `native`, `out`, `privateDir`, `log`,
  `findSnapshot(names)` (first **complete** snapshot: a steward-built snapshot counts only once its `SNAPSHOT.json`
  exists, so a snapshot still being built is never read), `snapshotInfo`, `cloneSnapshot` / `withClone` (`cp -c` into
  `$TMPDIR`; `lib/clone.mjs` refuses `~/Developer/scrolls-data` and `~/Documents`), `writeGenerated(relPath, text)`, and
  `inputs`, which a family sets to record what it read (it lands in the manifest entry).
- **Private families** (unredacted or large text) are written only to `~/Developer/scrolls-golden/<ref>/private/`; the
  committed `MANIFEST.json` lists them with their files' sha256, and tests that need them skip, visibly, when absent.
- **MANIFEST.json** (committed in `Tests/DifferentialTests/Golden/`, merged across partial runs): `reference_commit`,
  `ref_tag`, `node`, `icu`, `unicode`, `generator_sha256` (all `Golden/**.mjs`), `families.<name> = {tier, owner, module,
  private, cases, reference_commit, files: {file: sha256}, sha256, inputs?, attribution?, note?}`, and `generated` (the
  sha256 of each generated source). A reference tree with uncommitted changes under `src/ server/ data/ tests/` is
  recorded as `<commit>+dirty`.
- **Diff report.** Every run writes `Reports/golden-diff-<old12>-<new12>.json`: families changed (cases and sha256
  before/after), added, unchanged — the input of the §2.1 rebase protocol.
- **Redaction** (`lib/redact.mjs`): `redactText(s)` → `{"$redacted": sha256(UTF-8), "len": UTF-16 length}`;
  `makeRedactor(db)` binds it to `collection.export_text_allowed`; `assertNoRestrictedText(value, hashes)` is the
  generator-side twin of FixtureLicenceTests. The G1-core families commit text only from collections with
  `export_text_allowed = 1` (Cipher Gutenberg and Wikisource, STEMM Gutenberg, the synthetic demo).
- **Normalisation** (`lib/normalize.mjs`): `wellFormed`, `normalize` (timestamps → `<ts>`, data versions → `<dv>`,
  masked members → `<masked>`, an optional id mapper for natural keys), `float12`, `deltas`.

### Reading (Swift)

G1-core families are compared in `ScrollsCoreTests` (they only need ScrollsCore): `Support/Golden.swift` finds the
committed folder from `#filePath`, checks every file's sha256 against `MANIFEST.json` and the case count before reading
a case, resolves private families under `~/Developer/scrolls-golden/<ref>/private/` (`SCROLLS_GOLDEN_ROOT` overrides),
and writes `Reports/golden-<family>.json` = `{family, cases, mismatches, diffs (first 20), passed}` when
`SCROLLS_REPORTS_DIR` is set (`check.sh` sets it). Strings compare by code units and JSON by canonical bytes, never by
Swift's canonical-equivalence `==`. The generic `GoldenFamily`/`GoldenRule` API of IOS-SPEC §8.4.8 belongs in
`DifferentialTests/Support` with the other tiers (N0, with ScrollsService).

### `validate-contracts.mjs` (G7)

`node Golden/validate-contracts.mjs <responses.jsonl> [--report f.json]` runs the reference's `contracts.check` (shapes
plus "a gated value carries no numeral") over Swift-encoded bodies. A line is `{id, method, path, status, body,
request?}` (the shape comes from `ENDPOINTS`; non-2xx bodies are checked as `ErrorBody`) or `{id, shape, body}`.
Non-JSON endpoints (SSE, CSV, downloads, 204) are listed as skipped. Checked against the reference's own fixtures: all
230 variants of the 65 `tests/contract/*.json` (267 bodies) validate, 18 non-JSON variants skipped; a broken Health body
fails with exit 1.

### The LogicalDump format (normative for `dump.mjs` and `ScrollsStore/LogicalDump.swift`)

`node Golden/dump.mjs (--db <scrolls.db> | --mini [--keep-db <path>]) --out <dir> [--spec <dump-spec.json>]
[--tables a,b] [--fts full|skip]`. `--mini` builds the reference's mini fixture database with its own test helper
(`tests/helpers/tmpdata.mjs`) in a temp directory; `--keep-db` keeps a copy for the Swift side. The spec defaults to
`ScrollsStore/Resources/dump-spec.json` (written by the Store package). Both dumpers implement this text:

1. **Tables.** Every table of `sqlite_master` except `sqlite_*` and the shadow tables of virtual tables (`<v>_data`,
   `_idx`, `_content`, `_docsize`, `_config`, `_node`, `_parent`, `_rowid`). A table without a spec entry is an error.
2. **Spec entry.** `key` (natural-key parts), `ids` (`column → "self" | "<table>" | {"by": "<type column>", "map"?:
   {value: table}}`), `mask` (columns), `maskIf` (`{column, in: [values], mask: [columns]}` for keyed rows such as
   `meta`), `json` (columns parsed as JSON), `text` (columns written as digests), `virtual` (`column → rule`),
   `skip` (reason; the digest records `{skipped}`).
3. **Key parts.** A part naming an id column (other than `self`) → the natural key of the row it points to; a part
   naming a referenced table (`"document"`) → the natural key through the id column mapped to that table;
   `"<table>.<column>"` → that column of the referenced row; anything else → this row's column value. A natural key is
   the array of its parts; an id pointing nowhere is `{"$dangling": table, "id": n}`.
4. **Row.** `{"$key": <natural key>, <column>: <value>, …}` over every column except `self` ids, serialised with
   canonicalJson (sorted keys, numbers per Number::toString). Values: NULL → null; id columns → natural key; masked and
   non-NULL → `"<masked>"`; `json` → the parsed value; `text` → `{"$sha256": sha256(UTF-8), "len": UTF-16 length}`;
   BLOB → `{"$blob": sha256, "len": bytes}`; REAL columns (or any non-integer number) → 12 significant digits
   (`Number(x.toPrecision(12))`); other integers as is.
5. **Virtual rules.** `"TextStore.fullText → sha256"` → `{"$sha256", "len"}` of the full text (a device atlas reads it
   through TextStore); `"Revisions.expanded"` → the parsed, expanded `after_json` (compact device rows are expanded
   first); table rule `virtual.rows = "rowid → passage key; fts5vocab instance (term, doc key, offset) → sha256"` (or
   `{"fts5vocab": "<vocab table>", "doc": "<table>"}`) → one row per FTS instance: `[term, doc natural key, column,
   offset]`.
6. **Order and digest.** Lines sorted by the canonical JSON text of the natural key (UTF-16 code-unit order), ties by
   the line's text; one line per row, `\n`-terminated; `digest.json` = `{table: {rows, sha256 of the file bytes}}`.

Exercised on the mini database with a throwaway spec covering all 58 tables (the real spec is the Store package's):
18 tables with rows (document 12, passage 15, FTS instances 404, …); two runs are byte-identical.

## N0 · G1 core (generated 2026-10-10)

`Golden/gen-core.mjs`, group `g1.core`. Reference `839c3f1` (`ref-freeze-1`), Node v26.10.0, ICU 78.3, Unicode 17.0;
corpus inputs from the `m5r` snapshot (built from `ref-freeze-1`). Committed: 19 families, 9,256,242 bytes. Private:
2 families (36.7 MB) under `~/Developer/scrolls-golden/839c3f1…/private/`. All compared **exact**; result of
`Tools/check.sh quick --wp N0`: 32 tests passed, every family 0 mismatches (`Reports/check-quick-*.json`,
`Reports/golden-g1.*.json`).

| Family | Cases | What it pins (Swift side) |
|---|---|---|
| g1.token-classes | 3,964 runs | the generated two-stage table = Node's `\p{L,M,N,Co,So,Lu,Ll,Lt,Z,P,Cased,Case_Ignorable}`, scripts and `\s` for all 1,114,112 code points |
| g1.tokenize | 1,756 | `Tokenizer.tokens`/`spans`/`TokenInterner`: 96 edge strings and 1,000 fuzz strings in full; 660 corpus passages (60 per language) as offsets + norms sha256 |
| g1.tokenize-corpus (private) | 4,340 | the rest of the 5,000 sampled corpus passages (en, und-Latn, und, fr, es, hi, gu, de, it, pt, la), in full |
| g1.fold | 2,668 | `Fold.fold` on every scalar (2,621 that change, the rest identical) and 47 word contexts (Final_Sigma, NFC, digits, joiners) |
| g1.text-helpers | 789 | `findSequence`, `ftsPhrase`, `isSentenceInitial` |
| g1.sentences | 273 | `SentenceBreaker.starts` on 45 edge strings and the 228 demo documents |
| g1.sentences-books (private) | 50 | 30 Cipher Gutenberg + 5 Wikisource hi + 5 gu + 10 STEMM Gutenberg books: 673,566 of 673,566 boundaries |
| g1.daymath | 3,043 | `ymdFromDay`/`dayFromYMD` every 97th day of years −10000…3000 (packed), 3,000 rollovers, leap years and month lengths |
| g1.dates | 7,725 | `DateGrammar.parse` on every distinct raw date of m5r (OpenAlex sampled to 1,462), the reference's test strings, the §5.3 examples, 2,000 fuzz strings, and 7 option variants |
| g1.date-labels | 2,335 | `yearLabel`, `yearRangeLabel`, `fromInterval`, `fromDayInterval`, `formatDateLabel` |
| g1.bins | 8,021 | `binOf`, `fits`, `fitsDays`, `monthBinOfDay`, `tierForPpy` and their RangeErrors |
| g1.jsnumber | 20,552 | `JSNumber.format` (Number::toString) on 20,000 doubles and the edge cases |
| g1.js-math | 1,564 | `JSMath.log10`/`log`, `JSNumber.round` bit for bit; `toFixed`, `toPrecision` byte for byte |
| g1.canonical-json | 1,515 | `JSONValue.parse` then `CanonicalJSON.string` |
| g1.mulberry32 | 32 | 32 seeds × 300 draws, bit for bit |
| g1.ids | 1,540 | `fnv1a32`, `shortHash`, `slug`, `ref`, `parseRef` |
| g1.viewstate | 561 | `defaultState`, `canonicalize` + warnings, `encode`, `decodeHash` + warnings, `stateHash`, the filter grammar (500 random states, 51 hashes) |
| g1.evidence-style | 2,214 | `edgeStyle` (every status × review × quality × hue family × flags), `binStyle`, BADGES, LEGEND_ROWS |
| g1.vocab | 209 | every export of vocab.mjs = the generated `Vocab`/`Copy` statics = `Resources/vocab.json`; `fillTemplate` |
| g1.format | 6,205 | `formatCount/Number/Tokens/Share/Rate/CI`, `unitLabel`, `totalsText`, `refWords` |
| g1.collation | 3,100 | `ReferenceCollation.compare` = `localeCompare(…, 'en')` (DV-4) |

Generated sources (sha256 in MANIFEST `generated`): `ScrollsCore/Text/TokenClassTable.swift`, `ScrollsCore/Vocab.swift`,
`ScrollsCore/Copy.swift`, `ScrollsCore/Resources/vocab.json`.

### Parity found and designed in while porting

- **Final_Sigma (extends DV-1).** NSString's `lowercased` is not ICU's either: it gives "ς" for "ͅΣ" (U+0345 is cased
  *and* case-ignorable, and ICU skips it), and "σ" where ICU gives "ς" when a colon or soft hyphen (both
  case-ignorable) separates Σ from the preceding cased letter ("é\u{AD}:Σ⃣᙭"). `JSString.toLowerCase`
  lowercases everything but Σ through NSString (context-free) and applies ICU's `ucase_toFullLower` rule to Σ with
  Cased/Case_Ignorable bits generated from Node. Fold, slug, date prep and the sentence-initial test all use it.
- **Math.log / Math.log10.** V8's fdlibm port, compiled for arm64 with clang's default `-ffp-contract=on`, fuses
  multiply-adds inside expressions; a plain port differed by 1–2 ulps on 4 of 1,564 values. `JSMath` reproduces the
  fusions (left operand first, as clang's `tryEmitFMulAdd`): bit-identical on all of them.
- **JSON object keys.** Swift's `[String: _]` identifies canonically equivalent keys ("é", "e\u{301}"), JSON.parse keeps
  both (11 of 1,515 canonical-JSON cases). `JSONValue.object` holds a `JSONObject` whose keys compare by code units, and
  `JSONValue ==` compares strings by code units. Deviation from the frozen `object([String: JSONValue])`; `JSONObject`
  has the dictionary API (subscript get/set, keys, values, literals, `mapValues`, `init([String: JSONValue])`).
- **Collation (DV-4).** Foundation's `compare(_:locale:)` agrees with ICU on every unequal pair; on its ties ICU still
  orders tertiary differences ("fi" < "ﬁ", reproduced by `.forcedOrdering`) but calls canonically equivalent strings
  equal (which `.forcedOrdering` splits). The rule "compare; on a tie, equal if canonically equivalent, else forced"
  matches 3,100 of 3,100 (titles, lane labels, rel-type labels, demo names, edge strings).
- **Sentence breaks (DV-3).** NSString `.bySentences` enclosing-range starts + the ।/॥ pass: 673,566 of 673,566 on the
  50 m5r books (en, hi, gu); the device re-check is the probe's (PENDING_DEVICE).
- **Unicode drift.** 0 scalars differ between the u61m-1 table (Unicode 17.0) and the macOS 27.2 runtime's general
  categories (printed by `unicodeDriftReport`, never applied).
- **Number formatting.** `JSNumber` is Number::toString from Swift's shortest digits, and toFixed/toPrecision round the
  double's exact decimal expansion half away from zero (ECMA-262), not printf's half-even.

### Out of the Swift domain, and findings (for DIVERGENCES.json, whose owner is N0's Store/Service part)

| Proposed | Area | What | Rule / status |
|---|---|---|---|
| finding for R | viewstate.mjs, format.mjs | Plain-object lookups see `Object.prototype` keys: `lg=…~toString~` keeps a lineage type `toString`, `tg=constructor1` is dropped without a warning, `refWords('constructor:1')` prints a function. Swift treats them as unknown values. | proposed RF: `Object.hasOwn` / `Map`; no golden contains such input |
| DV (accepted) | JSONValue Codable | Decoding through `JSONDecoder` uses Foundation's dictionary and merges canonically equivalent keys; `JSONValue.parse` does not. | engine JSON goes through `JSONValue.parse` |
| DV (accepted) | ids.slug | A cut through a surrogate pair leaves U+FFFD where JavaScript leaves a lone surrogate (what SQLite stores is U+FFFD either way). | goldens are well-formed UTF-16 |
| out of domain | dates.fromInterval | JavaScript accepts a non-integer year and throws; the Swift API takes `Int`. | 1 golden case, counted and excluded by the test |
| out of domain | JSNumber.parse | 0x/0o/0b literals above 2^53 round per digit, not as V8's radix parser. | not reachable from the view-state grammar |
| out of domain | ViewState runs | `Object.entries` order of non-index keys of `runs.materialize` (e.g. "007") is insertion order; a JSONValue object has none, so Swift uses code-unit order. | differs only when two such keys name the same run id |

### Regeneration log

| Date | Families | Ref | Inputs | Result |
|---|---|---|---|---|
| 2026-10-10 | g1.core (21 families) | `839c3f1` = `ref-freeze-1` | m5r | first generation; diff reports `golden-diff-none-839c3f1a6ac6.json`, `golden-diff-839c3f1a6ac6-839c3f1a6ac6.json` (compaction, two class bits, inputs moved from the m5-stemm fallback to the completed m5r) |
| 2026-10-10 | g1.core (21 families) | `10c23d1` (R's RF-4 commit: docs only on top of `ref-freeze-1`; `git diff 839c3f1 10c23d1 -- server src tests data scripts public tools package.json` is empty) | m5r | 0 families changed, 21 unchanged (`golden-diff-839c3f1a6ac6-10c23d1e158f.json`). The committed MANIFEST.json now records `reference_commit` 10c23d1 with `ref_tag` null (HEAD is not the tag), on a tree byte-identical to `ref-freeze-1`. |
| 2026-10-10 | g1.core (21 families) | `10c23d1` | m5r | the M0 stitch: the generator tree gained the other packages' stub `gen-*.mjs`, `slices.mjs` and `probe-samples.mjs`; 0 families changed, 21 unchanged (`golden-diff-10c23d1e158f-10c23d1e158f.json`); `generator_sha256` 3a75b92d… → 03d236a4… |

## N0 · the M0 stitch (2026-10-10)

### C0 and G1 in every gate

`Tools/check.sh quick` (no `--wp`) now builds every declared target, so C0 runs twice per gate: in
ScrollsContractsTests (writes `Reports/c0-contracts.json`, read into a "C0 contract round trip" row) and in
`DifferentialTests.ContractRoundTripTests`; `DifferentialTests.GoldenHarnessTests` (g1.ids through `GoldenFamily`)
runs with them. Measured on the stitched tree: C0 260 / 260 bodies, 0 mismatches, 0 without a Swift type; all 21 G1
families 0 mismatches (`Reports/check-quick-20261010T083930Z.json`, the final tree). quick runs only N0's suites of
DifferentialTests; the other tiers' families there are run by their owners' `check.d` stages.

**When a `ref-freeze-n` changes `tests/contract/`**, re-copy the files into
`ScrollsService/Resources/contract-fixtures/` in the same commit as the regenerated goldens: the byte-equality tests
(ScrollsServiceTests "Bundled contract fixtures", DifferentialTests `ContractRoundTripTests.byteEqual`) fail until then.

### The other tiers' generators (stubs)

Each `Golden/gen-*.mjs` of §8.1 exists as a stub owned by its package. It declares its planned families (the names below)
with a `run` that throws "not implemented yet", so `run.mjs --list` shows them and a run that selects one fails instead
of committing an empty golden. The owner may rename a family; the manifest then gains the new name.

| Module (owner) | Group | Planned families |
|---|---|---|
| `gen-pipeline.mjs` (N1) | pipeline | g1.segment, g1.langid, g2.mini, g2.ingest, g2.demo |
| `gen-sources.mjs` + `slices.mjs` (N2) | sources | g2.cipher-slice, g2.stemm-slice |
| `gen-read.mjs` (N3) | read | g1.variants, g1.translit, g1.names, g1.kwic, g3.read-m1r, g3.read-m5r |
| `gen-analysis.mjs` (N4) | analysis | g1.stats, g3.compare, g4.analysis |
| `gen-lineage.mjs` (N5) | lineage | g1.minhash, g1.winnow, g3.lineage, g4.reuse-index |
| `gen-journey.mjs` (N6) | journey | g7.journey-m1r, g7.journey-m5r |
| `gen-display.mjs` (N7) | display | g5.display |

Adding these files changes `generator_sha256` (it covers every `Golden/**.mjs`), so N0 regenerated g1.core once the
stubs and `probe-samples.mjs` were in: 0 of 21 families changed, and the committed MANIFEST.json now records the
generator hash of this tree (`03d236a4…`).

### The probe's sample books (DV-3 on the device)

`Golden/probe-samples.mjs` writes `Scrolls/Resources/Probe/` (bundled as the app's `Probe/` folder): three books whose
text **and sentence starts come from the private family g1.sentences-books, i.e. from Node's `Intl.Segmenter`**, so the
device probe checks "iOS = the reference", not "iOS = this Mac".

| Sample | Source (m5r) | Licence | UTF-16 units | Sentences |
|---|---|---|---|---|
| `en-third-class-in-indian-railways` | cipher-gutenberg pg:24461 (Gandhi, 1917) | Public domain (US) | 74,240 | 1,846 |
| `hi-kavitavali` | cipher-wikisource-hi कवितावली.pdf (तुलसीदास) | CC BY-SA (Wikisource) | 94,071 | 2,951 |
| `gu-mameru` | cipher-wikisource-gu Mameru.pdf (પ્રેમાનંદ) | CC BY-SA (Wikisource) | 29,540 | 796 |

Each `<name>.sentences.sha256` is the sha256 of `JSON.stringify(starts)`, which is what `Probe.sentenceDigest` computes;
`MANIFEST.json` in the folder carries the attribution and the family's sha256. All three collections have
`export_text_allowed = 1` (§2.6). Results: the iOS 27 simulator (the simulator runtime's own ICU, reported as
`ios27.0/unicode17.0`: a proxy, not the device) PASSES 3 / 3 (`Reports/probe-sim.json`); so does `scrolls-cli probe --texts Scrolls/Resources/Probe` on this Mac (ICU macos27.2/unicode17.0); the device row is
PENDING_DEVICE.

### LogicalDump: what the spec file pins (from the Store part, N0b)

- **Skipped tables** (`dump-spec.json` `skip`, with the reason recorded in `digest.json`): `annotation_fts`
  (contentless, and schema.sql has no fts5vocab for it), the views `passage_vocab_row` and `passage_vocab_inst`, the
  operational and cache tables `job`, `job_event`, `query_def`, `tile_cache`, `layout_cache`, and `text_chunk` (covered
  by `document_text`'s virtual `original`).
- **Keys.** `import_batch` has no `ord` column, so its key is `[collection.slug, adapter_id, file_sha256, file_name,
  format, status]`; `relationship`'s key uses the real columns (`src_type`, `src_ref`, …), not `src`/`dst`.
- **One rule dump.mjs leaves to JSON key order and LogicalDump.swift pins:** a key part that names a table must map
  through exactly one id column (`DumpSpec` validates it).
- **Fixture.** `ScrollsKit/Tests/ScrollsStoreTests/Fixtures/mini-dump/` holds the reference's mini database and Node's
  dump of it; regenerate it whenever `dump-spec.json` or `Golden/dump.mjs` changes (its MANIFEST.json lists the
  commands, and the test refuses a stale fixture).
- **Result.** LogicalDump Swift = Node on the mini database: 50 / 50 dumped tables byte-equal, 8 skipped by both
  (`Reports/golden-logicaldump-mini.json`); the same database converted to chunked text dumps identically, and compact
  create revisions dump equal to full ones (DV-11, DV-12: proven on the mini database, pending at scale).
- **Pending for G2 across id schemes (N2's request):** rules for raw ids inside text — `label_tri.ref`
  ('document:12'), `relationship.created_by` ('run:7'), `date_assertion.asserted_by` ('import:17') and saved_view's
  cutoff numbers — before G2 compares a slot-range atlas with a Node-built one.

### The divergence register at M0

`Tests/DifferentialTests/Golden/DIVERGENCES.json`: 19 entries.
- Updated: DV-1 (NSString's own Final_Sigma gaps — after U+0345, and across a case-ignorable colon or soft hyphen —
  closed by `JSString`'s ICU rule for Σ), DV-3 (simulator evidence), DV-11 and DV-12 (mini-database evidence).
- Added: DV-16 `dimension_def.options_json` key order (sorted canonical JSON vs `JSON.stringify` order; JSON-equal,
  compared as JSON), DV-17 `runs.materialize` key order, DV-18 radix literals above 2^53 in `JSNumber.parse`, DV-19 the
  non-integer year of `fromInterval` (the last three out of domain: no golden or grammar reaches them).
- Open: DV-3 (device), DV-4 (the M1 sweep over every label), DV-8 (N4's "no output change" test), DV-11 and DV-12
  (a converted m1r/m5r atlas). None of them is in a module that is exact and finished at M0 except DV-3, whose Mac and
  simulator rows pass and whose device row is queued.


## N2 · G2 on the Cipher slice (2026-10-13)

`Golden/slices.mjs` writes the slice in Cipher's own formats and folder layout (deterministic, mulberry32 2026; it reads
the Cipher folder read-only): 2,000 culture works covering every relation label × source code (60 keys), the year edge
cases (empty, scheduled, BCE), 150 works of the tagging batches and the works that relation endpoints alias onto, rows
renumbered 0…1999 with sibling references rewritten; 300 themes; 500 roots families (0, 1, chain and several parents);
5,000 raw music relations (all 428 ItwoFS, written in the source files' own JSON styles); 25 Gutenberg books (6 with
`***START OF`, 3 SMALL PRINT, #1661 with its 3 QIDs, 2 double-BOM books, #135, #19942, the rest drawn) with their raw
catalogue records; 20 + 20 Wikisource books (the undated first). `Golden/gen-sources.mjs` has the frozen reference build
it in a child process (SCROLLS_CIPHER_ROOT set before config.mjs is imported): an empty database (migrate, seedVocab,
the file and source adapters), `bootstrap-cipher {mode:'all'}` at the test clock 2026-10-04T12:00:00Z, then dump.mjs.

| Family | Committed | Cases | What |
|---|---|---|---|
| g2.cipher-slice | yes (≈ 0.7 MB) | setup + one digest per table + the rows of tables ≤ 600 rows | the slice's input files (path, size, sha256) and the reference's dump |
| g2.cipher-slice-rows | private (size) | `{kind:'rows', table, lines[≤ 2,000]}` for every table but passage_fts (compared by digest: its instance rows hold no raw ids), and `{kind:'idmap', table, pairs}` | for the first-difference report and the id mapping |
| g2.cipher-slice-inputs | private (size) | the 69 slice files, base64 | so the Swift side reads the bytes the reference read |

Swift side: `DifferentialTests/Sources/CipherSliceTests` packs the slice as `Tools/packs.sh` packs Cipher
(`CipherPacks.sources`), runs phases A, A2 and B through `AtlasEngine` from an empty device atlas, dumps it with
`LogicalDump` and compares every table of the reference's dump. Rules beyond the dump spec (each requested as a DV or a
dump-spec rule in status/N2.md): the device profile's own tables and meta keys are not compared; `original_file.rel_path`
and `.source_path` are masked (pack paths by design, §3.5); raw ids inside text (`document:12`, `run:7`, …) are mapped on
both sides through id-free keys (`slices.mjs` `ID_MAP_SQL`); import batches are collapsed by natural key without
`options_json`/`summary_json` (a long load commits one batch per ≈ 20 s chunk on both sides, so their number depends on
the machine); `meta.cipher_bootstrap` (timings) is masked. A second test closes the engine during phase B (2 s chunks),
reopens it, and checks that the resumed job finishes with no document twice and the same dump. Stage: `Tools/check.sh
slice` (report `Reports/golden-g2.cipher-slice.json`).

### Regeneration log (N2)

| Date | Families | Ref | Result |
|---|---|---|---|
| 2026-10-13 | g2.cipher-slice, g2.cipher-slice-rows, g2.cipher-slice-inputs | `5a9cbe0` (reference tree = `ref-freeze-1`) | first generation (`golden-diff-…-5a9cbe09f3f8.json`: 3 added); the rows family was then repacked into multi-line cases (it had 1,683 files) and regenerated |
