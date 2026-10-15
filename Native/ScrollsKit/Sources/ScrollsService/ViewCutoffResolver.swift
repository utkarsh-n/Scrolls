// OWNER: N6
// The as-saved cutoffs of a saved view (IOS-SPEC §6.4, D17 across generations). In the generation where the view was
// saved, the `saved_view` numbers are used exactly as in the reference (a test asserts the resolver recomputes the same
// numbers there). In any other generation every numeric cutoff is recomputed from `journal_applied.max_ids_json` of the
// entries before the view's own `seq` (with `meta.base_max_ids` of the starter), pinned runs are found by RunKey (a
// missing one is named: "pinned analysis being restored (run #14)"), and strand, selection and run ids are remapped
// through `PortableCutoffs`. Nothing is silently re-pinned, and "as-saved unavailable" is never shown.
// Used by `LiveAtlas.view(_:asSaved:)` (LiveAtlas+Views.swift); the logic is ScrollsProvenance's `PortableResolver`.

import Foundation
import ScrollsContracts
import ScrollsProvenance
import ScrollsStore

/// Resolves the cutoffs of an as-saved view in the current generation.
public enum ViewCutoffResolver {
  /// The cutoffs of `view` here, with the banner when it was saved in another generation.
  public static func resolve(_ c: Connection, text: any TextStore, view: SavedViewRow) throws -> PortableResolution {
    try PortableResolver.resolve(c, text: text, view: view)
  }

  /// cutoff′ recomputed from the journal for an act `journalSeq` (equals the stored numbers in the generation of the
  /// save: `ViewCutoffResolverTests`).
  public static func recompute(_ c: Connection, journalSeq: UInt64) throws -> (importBatch: Int64, annotationRev: Int64, relationshipRev: Int64) {
    try PortableResolver.recompute(c, journalSeq: journalSeq)
  }
}
