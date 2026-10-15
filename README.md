<!-- OWNER: WP8 — written at the final integration gate (2026-10-08) -->
# Scrolls — A Living Atlas of Meaning

Scrolls is a local web app for following how words and phrases are used over time. You track an *expression* (a word, a phrase, a symbol, a work, a maker or a theme). Every use found in your texts becomes a mark on **the Scroll**, a zoomable timeline with one lane per domain, language, collection or field. Each mark opens the passage it came from. Every count names its denominator. Gaps where nothing was looked at are drawn as gaps, never bridged.

Computed estimates exist only when their minimum-evidence gate passes; otherwise the app shows what is missing. These include usage-context groups, drift between periods, lineage between texts and the correlation with an external baseline. Similarity is never shown as influence. The first date in the record is labelled "first observed in this corpus", never "coined".

It runs on your Mac with zero npm dependencies (Node ≥ 26, `node:sqlite`, vanilla ES modules, Canvas 2D/SVG). It makes no network request; source fetchers are separate scripts that you run yourself.

- Full specification: [Docs/SPEC.md](Docs/SPEC.md). What works and what is unfinished: [Docs/HANDOFF.md](Docs/HANDOFF.md).
- HTTP API (contract 1.3.0): [Docs/API.md](Docs/API.md). Import formats: [Docs/IMPORT-SCHEMA.md](Docs/IMPORT-SCHEMA.md).
- Analysis methods and their limits: [Docs/ANALYSIS-AND-LIMITS.md](Docs/ANALYSIS-AND-LIMITS.md).
- How Cipher's data is mapped: [Docs/CIPHER-MAPPING.md](Docs/CIPHER-MAPPING.md). Test and journey record: [Docs/VERIFICATION.md](Docs/VERIFICATION.md).

## Setup

```sh
node --version          # v26 or later (node:sqlite, node:test, worker_threads)
npm start               # → Scrolls is running at http://127.0.0.1:3460/
```

There is nothing to install. The server binds only to `127.0.0.1:3460` and refuses foreign `Host` and cross-origin requests.

**Data directory.** Everything the app writes lives in `~/Developer/scrolls-data` (override it with `SCROLLS_DATA`):
- `scrolls.db`, the SQLite database;
- `originals/`, the verbatim bytes of every imported file;
- `derived/`: token streams, vector spaces and the Wiktionary word index;
- `sources/`: staged STEMM files, which the app only reads;
- `cache/`, `exports/` and `logs/scrolls.log`.

The app refuses a data directory inside iCloud (`~/Documents`, `~/Library/Mobile Documents`) with `E_DB_IN_ICLOUD`. Keep the code folder wherever you like; keep the data outside iCloud.

| Variable | Effect |
|---|---|
| `SCROLLS_DATA` | data directory (default `~/Developer/scrolls-data`) |
| `SCROLLS_PORT` | port (default 3460; `0` picks a free port) |
| `SCROLLS_NO_AUTO_IMPORT=1` | skip the first-launch Cipher import |
| `SCROLLS_CIPHER_ROOT` | where the Cipher datasets are (default `~/Documents/AI Stuff/Cipher`) |
| `SCROLLS_MOCK=1` | serve the canned contract fixtures instead of the database (UI development) |
| `SCROLLS_READ_WORKERS`, `SCROLLS_LOG_LEVEL` | read-pool size (default 3); log level |

## First launch

1. **The synthetic demo opens at once.** It is the "carry the zero" world: invented people, texts and dates, labelled SYNTHETIC everywhere. A one-minute tour plays three coach marks: the bars of observed decades, the evidence styles of documented, computed and proposed links, and Play.
2. **The tour ends on a "Your turn" card.** It offers *Switch to Cipher (real data)* and three starting words.
3. **Meanwhile Cipher loads in the background.** Its metadata comes first: culture-work titles, music relations, themes and etymology, within about a minute. Then the full text of the Gutenberg and Wikisource books is indexed. The **Cipher ready** chip in the toolbar shows the progress.
4. **A boot-time check** confirms that every file in `originals/` is still on disk. `GET /api/health` reports it as `integrity`.

## Loading the STEMM sources

The four STEMM sources are read from files staged under `$SCROLLS_DATA/sources/<name>/` (each with `FORMAT.md` and `MANIFEST.json`). The fetchers are the only code that touches the network, and you run them yourself:

```sh
node tools/fetch/gutenberg-stemm.mjs     # Project Gutenberg science, medicine and engineering shelf (text)
node tools/fetch/openalex.mjs            # OpenAlex: top-cited works per field × 5-year cell (titles, abstracts, citations)
node tools/fetch/wiktionary-coinage.mjs  # Wiktionary attestation claims (kaikki.org)
node tools/fetch/ngram-baseline.mjs      # Google Books Ngram 1-gram baseline (English)
```

Then load them in the app:
- **In the browser:** open the **Adapters** page: **More → Sources and adapters…**, the **Sources** button of the Jobs tray, or a Term trail lane's "Load sources" link. Searching a word offers "STEMM sources not loaded yet" when there are staged files; the page is also at `/#v=1&c=demo&p=tnn,adapters`. Press **Load** on a source. A load runs as a job in the Jobs tray. Large sources load in chained chunks, and documents already committed are kept if you cancel.
- **Over the API:** `POST /api/adapters/<id>/load`, for example `stemm.gutenberg-stemm`, `stemm.openalex` or `stemm.wiktionary`. Send `Origin: http://127.0.0.1:3460` on every POST. The Ngram baseline is read in place; it has no Load.

The toolbar then offers **STEMM** and **All real** (the virtual corpus `real`: every non-synthetic corpus, never the demo). The lanes menu has the preset **Term trail (all real corpora)**.

## Importing your own files

- **In the browser:** use **Import a file** in the toolbar, also at `/#v=1&c=demo&p=tnn,import`. The wizard runs four steps: drop the file, map the fields, validate (a dry run with a problem list), then commit as a job. A committed import can be reverted.
- **Formats:** TXT, Markdown (with front matter), CSV/TSV, JSON and JSONL, in UTF-8 or Windows-1252.
- **The fields:** a date, a title, an author and any metadata. Unknown or invalid dates are kept as undated, with a suggestion. The schema, date grammar and error codes are in [Docs/IMPORT-SCHEMA.md](Docs/IMPORT-SCHEMA.md).
- **Over the API:** `POST /api/imports` (raw body with the `X-Scrolls-Filename` header), then `PUT /api/imports/:id/mapping`, then `POST /api/imports/:id/commit` ([Docs/API.md](Docs/API.md)).

## Tests and verification

```sh
npm test                 # the whole suite (node --test tests/*.test.mjs); uses temp data dirs only
npm run verify           # npm test, then the acceptance journey on a clone of a snapshot (never the live data dir)
npm run verify -- --no-test --snapshot ~/Developer/scrolls-snapshots/m5r --record /tmp/journey.jsonl
npm run bench            # timings on a STEMM-scale clone (not pass/fail)
npm run build:nl         # optional: the on-device Apple NaturalLanguage adapter (tone, modern-reader neighbours)
```

- **`npm run verify`** clones the snapshot (`cp -c`; default `~/Developer/scrolls-snapshots/m1r`, the snapshot built from `ref-freeze-1`, else `m1`) with its `originals/` and boots a private server on a free port. Over HTTP it then runs: import, search, track, timeline tiers L0–L5 with the conservation law, passage offsets, Compare gates, saved views with as-saved Compare, an annotation and a link review, restart and reopen, an import reverted after the save and the views as saved, and the originals check. Every JSON response is checked against its contract shape, and every request and response is recorded as JSONL (`--record <file>`). It prints a PASS/FAIL table.
- **In the browser,** `/?selftest=1` checks the modules, five API shapes, the painted canvas and the console.

## Keyboard

Press **?** in the app for the whole map (the full list is in `src/ui/shell/help.mjs`, SPEC §8.5). The essentials:

| Key | Action |
|---|---|
| `/` | search |
| `Space` | play or pause |
| `[ ]` | move the vantage by one bin |
| `0` | fit the data |
| `1`–`6` | jump to a time tier |
| `D` | deep-time overview |
| `L` | cycle the lane facet |
| `E` | cycle the evidence filter |
| `C` | Compare |
| `G` | Lineage |
| `K` | Constellation |
| `N` | Notebook |
| `S` | save a view |
| `X` | export |
| `T` | table alternative |
| `R` | reduced motion |
| `Esc` | close or clear |

On touch screens, panels open as sheets with Then / Now / Next tabs.


## Public snapshot

See [PUBLICATION.md](PUBLICATION.md) for publication exclusions and setup requirements.
