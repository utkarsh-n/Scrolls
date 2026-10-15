<!-- OWNER: N2 — the measured storage budget, the device profile and slots as built -->
# Device data

As built by package N2 at M1 (IOS-SPEC §3). Measured numbers name where and how they were taken; a number taken on the
Mac or the simulator is a proxy, never a device measurement. Device rows are queued in `Reports/device-queue.json`.

## Source slots as built (§3.3)

Every entity row a source load writes takes an id of its adapter's slot (`SourceRegistry.slot(for:)`), so a rebuild, a
generation built on the Mac and a different order of loads give the same ids:

| Slot | Range | Adapter(s) | Rows |
|---|---|---|---|
| 0 | 1 … 99,999,999 | seeded vocabulary (corpora), `demo` | the starter: corpora, the demo world (228 documents, their passages, 11 relationships, the annotations) |
| 1 | 100,000,001 … | `cipher.works`, `cipher.themes`, `cipher.roots` | phase A: 94,385 works, glosses, siblings → relationships, tags; plus the Cipher text collections' rows (created in phase A so their lanes say "pending") |
| 2 | 200,000,001 … | `cipher.relations` | phase A2: relation endpoints, their aliases on works, documented music relations, merged evidence |
| 3 | 300,000,001 … | `cipher.books`, `cipher.wikisource` | phase B: 691 Gutenberg + 450 hi + 375 gu books |
| 4–6 | | STEMM (M2) | |
| local | 1,500,000,001 … | imports and on-phone runs | |

Log tables (`import_batch`, `analysis_run`, `relationship_revision`, `job`, …) keep `max + 1` (commit order). Collections
take their adapter's slot too (the text collections are slot 3 even though phase A creates them).

## The data path as built (§3.6)

1. **Starter** (`starter.atlas/atlas.sqlite`, built by `scrolls-cli starter` and bundled): cloned at first launch.
2. **Phase A** (`bootstrap-cipher {phase: A}`, pack `cipher-meta`): works with siblings, glosses and tags in one batch,
   then theme associations, then roots; journaled as `sourceLoad(cipher-meta, phase A)`.
3. **Phase A2** (`{phase: A2}`, pack `cipher-meta`): relation endpoints in ≈ 20 s chunks (each its own import batch,
   committed: a suspension loses at most one chunk), then aliases and relationships in one batch, then the evidence merge.
4. **Phase B** (`{phase: B}`, packs `cipher-meta` + `cipher-text`): books in ≈ 20 s chunks per collection (Gutenberg →
   Wikisource hi → gu), FTS automerge off while loading, then incremental `merge` steps (never `optimize`, ΔS-19), then
   the boilerplate pass (N5's `BoilerplatePass`).
Every phase is resumable from committed batches (what is loaded is read back; records the writer refused are remembered
in `meta.cipher_bootstrap.unloadable` and not retried) and ends with reconciliation counts in a `bootstrap-cipher` run.

## Measurements

Filled in as they are taken (see status/N2.md for the evidence files):

| What | Where | Value |
|---|---|---|
| `cipher-meta` pack | Mac (`Tools/packs.sh`) | pending |
| `cipher-text` pack | Mac | pending |
| starter | Mac | pending |
| phase A / A2 / B | Mac (`scrolls-cli bench`), simulator (`-selftest perf`, `background`) | pending |
| phase A / A2 / B | his iPhone 15 Pro Max | PENDING_DEVICE |
