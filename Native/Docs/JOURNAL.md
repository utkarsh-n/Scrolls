<!-- OWNER: N6 — the journal format, the ops, replay, portable cutoffs as built -->
# Journal

How his notebook survives a force quit, a restore from backup and a new atlas generation (IOS-SPEC §6, SPEC D17 and
D18), as built by N6 on top of N0's journal file and `UserWrites`. File names are under `Native/ScrollsKit/Sources/`.

## The file (N0: `ScrollsStore/Journal/{JournalFile,JournalTypes}.swift`)

- `Application Support/Notebook/journal-NNNNNN.jsonl`, rotated at 32 MB, backed up (the atlas is not).
- One canonical-JSON line per act: `{seq, at, actor, op, crc32}`; the CRC-32 covers the canonical JSON of
  `{seq, at, actor, op}`. `op` is the `JournalOp` in the contract's JSON shape, e.g.
  `{"view_save":{"request":{…},"portable":{…}}}`.
- An append is written and made durable (`F_FULLFSYNC`, else `fsync`) before it returns. At open, a torn last line (no
  newline, or a bad CRC on the last line) is truncated; a bad line anywhere else is reported as damage and replay stops
  before it — never silently dropped.

## The write path (every N6 route)

`LiveAtlas.journaledAct` (`ScrollsService/JournalReplayer.swift`), used by `LiveAtlas+{Annotations,Views,Relationships,Hypotheses}`:

1. **Dry run.** The reference's logic (the ScrollsProvenance port) runs on the writer inside a transaction that is
   always rolled back. It validates the request exactly as the act will be applied (every refusal of the reference —
   400, 404, 409 — happens here and nothing is journaled), and in the same snapshot it computes the act's **stable
   keys** (§6.3), so the journal never holds a row id that only means something in this generation.
2. **Append + fsync** (`UserWrites.perform`, N0).
3. **Apply** in one `BEGIN IMMEDIATE` transaction: `ProvenanceJournal.apply` resolves the op's stable keys to this
   generation's rows and runs the same reference logic with the act's own clock (`entry.at`), then
   `journal_applied` (with `max_ids_json`: the largest id of `import_batch`, `annotation_revision` and
   `relationship_revision`) and `meta.journal_applied_seq = seq` are written in that transaction.

A reference-profile atlas (the CLI on a snapshot clone) has no journal tables: the act is applied directly.

## The ops N6 applies (`ScrollsProvenance/ProvenanceJournal.swift`)

| Op | Stable keys it carries | Applied as |
|---|---|---|
| `annotationCreate` | target: `EndpointKey` (passage / occurrence by D18 anchor, document by `DocKey`, expression by `ExprKey`, cluster by `ClusterKey`), `RelKey`, `HypothesisGroupKey`, saved-view slug, time window `(RunKey, label)`, `AnnotationKey` | `Annotations.create` with the target and the anchor's document remapped; an anchor whose words are gone is kept as an **orphaned interpretation** (the row is written with the anchor it had, rev 1 reason `orphaned: …`) |
| `annotationRevise`, `annotationWithdraw` | `AnnotationKey` (the seq of the create) | `Annotations.revise` / `withdraw` |
| `annotationReinterpret` | `AnnotationKey` + a create op | `Annotations.reinterpret` |
| `relationshipPropose` | src, dst (`EndpointKey`), evidence spans (D18 anchors), group | `Relationships.propose`, spans re-located to their passage |
| `relationshipReview`, `relationshipEvidence` | `RelKey`: human = the seq of its proposal; computed = `(RunKey, src, dst)`; documented = `sha256(rel_type, src, dst, source_dataset, source_locator)@id` | `Relationships.review` / `attachEvidence` (the evidence status never changes) |
| `hypothesisGroupCreate` | target `EndpointKey` | `Hypotheses.create` |
| `dimensionDefine` | the key | inserted once |
| `clusterLabel` | `ClusterKey` | a `label` annotation, as in the reference |
| `viewSave` | the request + `PortableCutoffs` | `Views.save`, and the portable cutoffs into `saved_view_portable` (device profile) |
| `viewDelete` | the slug | soft delete |

Rows no journal act created (the starter's, a pack's) take generation-stable ids from their source slot (N-11); their
keys carry the id: an `AnnotationKey` / `HypothesisGroupKey` seq at or above 2⁵² is `2⁵² + id`, a documented `RelKey`
ends in `@id` and is checked against the row's natural hash on resolution. Which act created a log row is read from
`journal_applied.max_ids_json`: act `seq` created exactly the rows in (max before it, max after it].

## Replay (`ScrollsService/JournalReplayer.swift`, `ProvenanceJournal.replay`)

- Strictly in `seq` order, one transaction per act, through the same apply code as live writes; `ReplayReport
  {fromSeq, toSeq, resolved, reanchored, orphaned, waiting}`.
- **Launch catch-up** (`JournalReplayer.catchUp`): the acts with `seq > meta.journal_applied_seq` (a crash between the
  append and the commit). Idempotent by seq. `LiveAtlas.open` (N0) does not call it yet — see "Requests" below; the
  CLI (`scrolls-cli api`) and the self-tests call it after open.
- **A missing input blocks the rest** (`waiting`): an act whose document, run or relationship is not in this atlas,
  or another package's act with no handler in this build (an import, a source load). Skipping it would break the
  prefix property below.
- An act refused again exactly as when it was made (a deterministic 4xx) is marked applied with no rows.

## Portable cutoffs (D17 across generations; `ScrollsProvenance/PortableResolver.swift`, `ScrollsService/ViewCutoffResolver.swift`)

At save, `PortableCutoffs {generation, journalSeq, runKeys, strands, selection, packs}` is stored beside the immutable
`saved_view` row. At open:
- **Same generation:** the `saved_view` numbers, exactly as in the reference (tested: the resolver recomputes the same
  numbers there).
- **Any other generation:** `cutoff′(T) = max(journal_applied.max_ids_json[T] over seq < journalSeq, meta.base_max_ids[T])`
  for the three cutoff tables; pinned runs by `RunKey` (one not here is named: "pinned analysis being restored
  (run #14)"); strand, selection and run ids remapped through the portable keys; the banner "Saved on generation …;
  opened on generation …: ids remapped, counts as saved". Nothing is silently re-pinned, and "as saved unavailable" is
  never shown.

## Tests and evidence

- `Tests/ScrollsProvenanceTests/JournalTests.swift`: crash injection at 6 kill points (before the append, a torn
  append, after the append, after the apply, after `journal_applied`, after the commit) → applied exactly once or not
  at all, journal head = applied seq; a torn last line truncated at reopen; 30 scripted acts replayed into a rebuilt
  generation give byte-identical answers; D17 with shifted ids (another starter): cutoffs select exactly the rows
  before the view and as-saved counts are equal; an act of another package stops the replay with its reason.
- `AnchorsTests`, `AnnotationsTests`, `RelationshipsTests`, `ViewsTests`: the reference's provenance tests, ported.
- G7 (`Tools/check.d/journey.sh`, `scrolls-cli api --golden`): `g7.notebook-m1r` and `g7.journey-m1r`.
- Device rows (`Scrolls/Diagnostics/Steps/N6Steps.swift`): write-ahead, reopen identical, force quit (two launches),
  restore simulation, his live journal untouched.
