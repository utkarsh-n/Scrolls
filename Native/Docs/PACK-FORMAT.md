<!-- OWNER: N2 — SPK1, .scrollsatlas, .scrollsarchive, ATLAS.json -->
# Pack format

As built by package N2 (IOS-SPEC §3.5). Code: `ScrollsStore/Pack/{PackManifest,PackReader,PackWriter}.swift`,
`ScrollsService/Generations/GenerationManifest.swift`; tests: `ScrollsSourcesTests/PackFormatTests.swift`.

## The source pack: `.scrollspack`, format SPK1 (UTType `com.utkarsh.scrolls.pack`)

A pack carries a source's staged files **byte for byte**: each member is the file as it is on the Mac, under the relative
path the adapters read, and its sha256 is the sha256 of that file. So `import_once`, `original_file` and provenance behave
as in the reference, and a document loaded from a pack records `original_file.rel_path = 'pack:<name>@<sha8>/<member>'`.

### Layout (little-endian)

| Bytes | What |
|---|---|
| 12 | magic `SCROLLSPACK` followed by the version byte `0x01` (a reader refuses any other version, in words) |
| 8 + n | u64 length, then the **manifest**: canonical JSON (sorted keys, numbers per Number::toString), UTF-8 |
| 8 + n | u64 length, then the **index**: canonical JSON `{codec: "lzfse", format: "SPK1", frame_size: 1048576, members: [{path, size, sha256, offset, frames: [stored length…]}]}`; `offset` is relative to the start of the data |
| rest | the **data**: every member's frames back to back, in member order |

- **Frames.** A member is cut into 1 MiB raw frames (the last one shorter). Each frame is stored LZFSE-compressed, or raw
  when LZFSE would not shrink it (a frame's stored length equal to its raw length means raw). An empty member has no frame.
- **Range reads.** `PackReader.bytes(member:range:)` decodes only the frames that cover the range (positional `pread` on
  one descriptor, so adapters read members from several tasks at once); `stream(member:)` yields frame by frame.
- **Integrity.** The whole file's sha256 is streamed with CryptoKit (`fileSHA256()`; `PackLibrary` caches it per path,
  size and modification time, and `installPack` checks it before a pack is moved into `Atlas/packs/`). A member's sha256
  is checked the first time it is read in full (`data(member:)`, `verify(member:)`); a mismatch is `E_PACK_CHECKSUM`
  ("… does not match its sha256 … Nothing was loaded from it."), and nothing of that member is used.
- **Refusals.** A file that is not SPK1, another version, a head whose lengths are impossible (capped at 64 MiB), a frame
  that decodes to the wrong length, a member that runs past the end, or a manifest and index that disagree: `E_PACK_INVALID`
  with the reason. An unknown member: `E_PACK_MEMBER`. A pack a load needs but cannot find: `E_PACK_ABSENT`, with how to
  send it ("On your Mac: Tools/atlas.sh push-pack …").
- **Writing.** `PackWriter` streams members into a side file of frames, then writes `<pack>.building` (magic, the
  completed manifest, the index, the frames) and renames it into place, so a half-written pack never carries the final
  name. Member paths must be relative, inside the pack and unique. The same members give the same bytes (tested).

### The manifest

`{pack_id, name, version, slot, adapter_ids, created_by, reference_commit, licences, attribution, caveats, members:
[{path, size, sha256}], counts}`. `slot` is the source slot whose id range the pack's rows take (IOS-SPEC §3.3);
`created_by` is `scrolls-cli <engine version> <git sha>`; `counts` holds `members` and `files:<folder>` per folder.

### The packs this build makes (`Tools/packs.sh`)

| Pack | Slot | Members (Cipher's own relative paths) | Read by |
|---|---|---|---|
| `demo` | 0 | `documents.jsonl`, `relationships.jsonl`, `annotations.jsonl`, `tour.json` (= `data/demo/*`, engine resources) | `demo` |
| `cipher-meta` | 1 | `FORMAT.md` (written by the pack command), `culture-works.tsv`, `culture-themes.tsv`, `roots.tsv`, `tags/*.jsonl`, `songs/relations_{mb,wiki,itwofs}.json`, `texts/gutenberg.json`, `pg_catalog.csv` | `cipher.works`, `.themes`, `.roots`, `.relations` (phases A, A2) and, with cipher-text, `.books` |
| `cipher-text` | 3 | `FORMAT.md`, `texts/gutenberg/<id>.txt` (691), `texts/wikisource-{hi,gu}.jsonl` | `cipher.books`, `cipher.wikisource` (phase B) |
| `stemm` | 4–6 | each staged folder with its `FORMAT.md` and `MANIFEST.json` (`scrolls-cli pack --from`) | M2 |

`Tools/packs.sh` writes them to `~/Developer/scrolls-packs/v1/` (and `current` → `v1`), with `<name>.spec.json` (the
spec it packed), `<name>.inputs` (the sha256 of the spec and of every input's path, size and modification time: a pack is
rebuilt only when that changes) and `<name>.json` (the pack's sha256, size and member count). `Tools/build.sh` copies
`starter.atlas` and the Cipher packs from `current` into the app's `Resources/Bundled/` (cipher-text only when
`SCROLLS_BUNDLE_PACKS=1`, the default). The member lists live twice, as JSON in `packs.sh` and as `CipherPacks.sources` in
Swift (the slice test packs with the Swift list); a change goes into both.

## The starter: `starter.atlas/`

A directory: `atlas.sqlite` (slot 0: the seeded vocabulary and corpora, the demo world loaded through the ordinary
import path, and the demo's pipeline where this build has it; WAL checkpointed into the file) and `ATLAS.json`.
`scrolls-cli starter --out <dir>` builds it from nothing (`StarterBuild`); the phone clones `atlas.sqlite` at first launch.
The self-test `generation` suite rebuilds it on the phone and compares fingerprints with the bundled one (G6, slot 0).

## `ATLAS.json` (as built)

Canonical JSON, one object: `{generation, engine_version, engine_code_hash, stage_code_hashes, schema_version, profile,
tokenizer, segmenter, starter_sha256, packs: [{name, sha256, slot}], journal_seq, built_on, built_at, fingerprints:
{table: {rows, sha256}}}`. The facts come from the atlas's own `meta` keys and `pack_install`; `fingerprints` are the
LogicalDump digests of every table except the operational and cache ones (`job`, `job_event`, `query_def`,
`tile_cache`, `layout_cache`), `text_chunk` (covered by `document_text`'s virtual `original`) and the FTS/view tables
the dump spec skips. Equal fingerprints of two generations are G6 (`GenerationManifest.differingTables`).

## `.scrollsatlas` and `.scrollsarchive`

M2 work: a `.scrollsatlas` is a directory (`atlas.sqlite`, `derived/`, `ATLAS.json`); a `.scrollsarchive` is an Apple
Archive (LZFSE) of one, extracted by streaming. Installing one is a swap (§3.5 steps 1–7), never a merge; until it is
built, the Inbox lists such a file as "not in this build of Scrolls yet; nothing was changed".
