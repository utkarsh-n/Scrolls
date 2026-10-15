// OWNER: N0
// The places the shell can show (IOS-SPEC §4.2): pushed destinations (`Route`, kept in the scene's UI state so a
// relaunch restores the stack), root modals (`RootModal`, one system presentation at a time) and the cards a pushed
// destination presents (`CardModal`). Seeds carry only plain values (ids by kind, years, filters), so they encode
// into `@SceneStorage("ui")` and never hold engine objects.

import ScrollsContracts
import SwiftUI

/// Something a destination or card is about: an endpoint kind of `vocab.REL_ENDPOINT_TYPES` and its row id.
nonisolated struct NodeRef: Hashable, Codable, Sendable {
  /// "document", "passage", "occurrence", "expression", "etymon" or "cluster".
  var kind: String
  var id: Int64
}

/// What an annotation is about: a kind of `vocab.ANNOTATION_TARGETS` and its id (anchors are resolved by N6).
nonisolated struct AnnotationTarget: Hashable, Codable, Sendable {
  /// "passage", "occurrence", "document", "expression", "cluster", "relationship", "hypothesis_group", …
  var type: String
  var id: Int64
}

/// One side of a comparison: a year interval and a filter in the view-state grammar (`ViewState.Slice`).
nonisolated struct SliceSeed: Hashable, Codable, Sendable {
  var fromYear: Int
  var toYear: Int
  /// The `f` grammar ("lang:en;kind:book"), empty for the view's own filters.
  var filter: String = ""
}

/// Compare opens on two slices; A is always the earlier one (§4.10).
nonisolated struct CompareSeed: Hashable, Codable, Sendable {
  var a: SliceSeed
  var b: SliceSeed
  /// The view-state hash it was opened from, so Compare uses the same strands, lanes and cutoffs.
  var viewHash: String

  /// A seed with the earlier slice first, whatever order the brush gave.
  init(_ first: SliceSeed, _ second: SliceSeed, viewHash: String) {
    let ordered = (first.fromYear, first.toYear) <= (second.fromYear, second.toYear)
    a = ordered ? first : second
    b = ordered ? second : first
    self.viewHash = viewHash
  }
}

/// Lineage opens on a root node.
nonisolated struct LineageSeed: Hashable, Codable, Sendable {
  var root: NodeRef
}

/// Genealogy opens on a work.
nonisolated struct GenealogySeed: Hashable, Codable, Sendable {
  var work: NodeRef
}

/// The constellation opens on an expression and, from a Term trail, on the decade with the most matches (ΔS-13).
nonisolated struct ConstellationSeed: Hashable, Codable, Sendable {
  var expression: Int64?
  var query: String?
  var periodA: [Int]?
  var periodB: [Int]?
}

/// The notebook opens on its list, or on the annotations of one target.
nonisolated struct NotebookSeed: Hashable, Codable, Sendable {
  var target: AnnotationTarget?
}

/// A pushed destination (`NavigationStack` path, zoom transitions; §4.2).
nonisolated enum Route: Hashable, Codable, Sendable {
  case compare(CompareSeed)
  case lineage(LineageSeed)
  case genealogy(GenealogySeed)
  case constellation(ConstellationSeed)
  case notebook(NotebookSeed)
}

/// A system sheet presented from the root (at most one system presentation at a time).
nonisolated enum RootModal: Hashable, Identifiable, Sendable {
  /// The import wizard, optionally with a file that arrived through Open in Scrolls.
  case importFile(URL?)
  case sources, savedViews, lanes, filters, legend, howItWorks, settings, jobs, yearPicker
  /// Build, engine, probe and self-tests (N0; reached from More).
  case diagnostics

  var id: String {
    switch self {
    case .importFile(let url): "importFile:\(url?.absoluteString ?? "")"
    case .sources: "sources"
    case .savedViews: "savedViews"
    case .lanes: "lanes"
    case .filters: "filters"
    case .legend: "legend"
    case .howItWorks: "howItWorks"
    case .settings: "settings"
    case .jobs: "jobs"
    case .yearPicker: "yearPicker"
    case .diagnostics: "diagnostics"
    }
  }
}

/// A card presented by the top pushed destination.
nonisolated enum CardModal: Hashable, Identifiable, Sendable {
  case edge(RelationshipID)
  case node(NodeRef)
  case hypothesisGroup(HypothesisGroupID)
  case annotationEditor(AnnotationTarget)

  var id: String {
    switch self {
    case .edge(let r): "edge:\(r.rawValue)"
    case .node(let n): "node:\(n.kind):\(n.id)"
    case .hypothesisGroup(let g): "hypothesisGroup:\(g.rawValue)"
    case .annotationEditor(let t): "annotation:\(t.type):\(t.id)"
    }
  }
}
