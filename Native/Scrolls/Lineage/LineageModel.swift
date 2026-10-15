// OWNER: N5
// The Lineage explorer's state (IOS-SPEC §4.11, SPEC §2.C): the root, the filters (evidence status — the `E` cycle all →
// documented + computed → documented —, relation types, show rejected), the graph (opens at depth 2 with ≤ 60 nodes;
// ＋ expands one hop with ≤ 30 more; hard cap 150), list mode, and the chain of custody between two picked nodes.
// Everything is read through AtlasService; nothing here writes.

import Observation
import ScrollsContracts
import ScrollsCore
import ScrollsService
import SwiftUI

@MainActor @Observable
final class LineageModel {
  enum StatusMode: String, CaseIterable, Identifiable, Sendable {
    case all, documentedComputed, documented
    var id: String { rawValue }
    var statuses: [String]? {
      switch self {
      case .all: nil
      case .documentedComputed: ["documented", "computed"]
      case .documented: ["documented"]
      }
    }
    var title: String {
      switch self {
      case .all: LineageCopy.allEvidence
      case .documentedComputed: LineageCopy.documentedComputed
      case .documented: LineageCopy.documentedOnly
      }
    }
    /// The `E` key's cycle.
    var next: StatusMode {
      switch self {
      case .all: .documentedComputed
      case .documentedComputed: .documented
      case .documented: .all
      }
    }
  }

  static let openDepth = 2
  static let openMaxNodes = 60
  static let expandMaxNodes = 30

  let atlas: (any AtlasService)?
  private(set) var root: String
  private(set) var data: LineageResponse?
  private(set) var loading = false
  private(set) var error: ErrorCardModel?
  var statusMode: StatusMode = .all
  var types: Set<String> = []
  var showRejected = false
  var ordinal = false
  var listMode = false
  /// The selected node (its detail panel) or nil.
  var selected: String?
  private(set) var expanding: Set<String> = []
  // chain of custody
  var chainMode = false { didSet { if !chainMode { picks = []; path = nil; pathError = nil } } }
  private(set) var picks: [String] = []
  private(set) var path: LineagePathResponse?
  private(set) var pathError: ErrorCardModel?
  private(set) var findingPath = false

  init(root: String, atlas: (any AtlasService)?) {
    self.root = root
    self.atlas = atlas
  }

  /// The request for the current filters (`lineageQuery(view)`).
  func request(root: String? = nil, depth: Int = LineageModel.openDepth, maxNodes: Int = LineageModel.openMaxNodes) -> LineageRequest {
    LineageRequest(root: root ?? self.root, depth: depth, dir: "both", maxNodes: maxNodes,
                   types: types.isEmpty ? nil : types.sorted().joined(separator: ","),
                   status: statusMode.statuses?.joined(separator: ","), rejected: showRejected ? "1" : nil)
  }

  func load() async {
    guard let atlas else {
      error = ErrorCardModel(what: LineageCopy.loadFailed, message: "No engine is open.", hint: nil, code: nil)
      return
    }
    loading = true
    error = nil
    defer { loading = false }
    do {
      data = try await atlas.lineage(request())
    } catch {
      self.error = ErrorCardModel(any: error, what: LineageCopy.loadFailed)
    }
  }

  /// Re-roots the explorer (a node's "Lineage from here").
  func reroot(_ ref: String) async {
    root = ref
    selected = nil
    data = nil
    chainMode = false
    await load()
  }

  /// ＋: one more hop from a node (≤ 30 nodes), merged, with generations counted from the original root.
  func expand(_ nodeID: String) async {
    guard let atlas, let base = data, let node = base.nodes.first(where: { $0.id == nodeID }), !expanding.contains(nodeID) else { return }
    expanding.insert(nodeID)
    defer { expanding.remove(nodeID) }
    do {
      let more = try await atlas.lineage(request(root: nodeID, depth: 1, maxNodes: Self.expandMaxNodes))
      let baseGen = node.generation ?? 0
      var merged = LineageLayout.merge(base, LineageLayout.shift(more, by: baseGen))
      if let i = merged.nodes.firstIndex(where: { $0.id == nodeID }) { merged.nodes[i].expandable = 0 }
      data = merged
    } catch {
      self.error = ErrorCardModel(any: error, what: LineageCopy.loadFailed)
    }
  }

  /// Chain of custody: the second pick asks for the least-evidence-cost path.
  func pick(_ nodeID: String) async {
    guard chainMode else { return }
    if picks.count >= 2 { picks = [] }
    if picks.first == nodeID { return }
    picks.append(nodeID)
    path = nil
    pathError = nil
    guard picks.count == 2, let atlas else { return }
    findingPath = true
    defer { findingPath = false }
    do {
      path = try await atlas.lineagePath(LineagePathRequest(from: picks[0], to: picks[1],
                                                            types: types.isEmpty ? nil : types.sorted().joined(separator: ","),
                                                            status: statusMode.statuses?.joined(separator: ",")))
    } catch {
      pathError = ErrorCardModel(any: error)
    }
  }

  /// Edges shown under the client-side filters (`visibleEdges`; the engine filters too, this keeps an expanded graph
  /// consistent).
  var visibleEdges: [LineageEdge] {
    let statuses = statusMode.statuses ?? Vocab.evidenceStatus
    return (data?.edges ?? []).filter { e in
      statuses.contains(e.evidenceStatus) && (types.isEmpty || types.contains(e.relType))
        && (showRejected || e.reviewStatus != "rejected")
    }
  }

  /// Relation types present in the graph (the type chips).
  var presentTypes: [String] {
    let have = Set((data?.edges ?? []).map(\.relType)).union(types)
    return Vocab.relTypes.map(\.code).filter { have.contains($0) }
  }

  /// The root in words: its title with its reference ('Zero Holds the Place · passage 53').
  var rootWords: String {
    let words = root.replacingOccurrences(of: ":", with: " ")
    guard let n = data?.nodes.first(where: { $0.id == root }) else { return words }
    let t = n.title ?? n.label
    guard !t.isEmpty else { return words }
    return "\(t) · \(words)"
  }
}
