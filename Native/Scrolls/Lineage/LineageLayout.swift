// OWNER: N5
// The explorer's layout (port of src/ui/panels/lineage.mjs `layoutLineage`, `niceTicks`, `mergeLineage`,
// `shiftGenerations`), at the phone's scale: x from years (linear, or "ordinal spacing — equal width per dated year",
// labelled as such) over a width that grows with the number of distinct years (the graph scrolls sideways), rows by
// generation = hops from the root (never meaning); undated and commonplace nodes in the left gutter; the root's own
// document just under the root; nodes of one row closer than a label's width stagger. Pure value code.

import CoreGraphics
import ScrollsContracts

nonisolated struct LineageLayout: Sendable, Equatable {
  struct Node: Sendable, Equatable, Identifiable {
    var id: String
    var node: LineageNode
    var x: CGFloat
    var y: CGFloat
    var row: Int
    var gutter: Bool
    var rootDoc: Bool
  }
  struct Tick: Sendable, Equatable {
    var x: CGFloat
    var label: String
  }
  struct RowLine: Sendable, Equatable {
    var gen: Int?
    var y: CGFloat
    var label: String
  }

  var nodes: [Node]
  var ticks: [Tick]
  var rows: [RowLine]
  var width: CGFloat
  var height: CGFloat

  static let yearPt: CGFloat = 96
  static let maxWidth: CGFloat = 2000
  static let gutter: CGFloat = 84
  static let pad: CGFloat = 28
  static let rowHeight: CGFloat = 92
  static let top: CGFloat = 36
  static let stagger: CGFloat = 22
  static let minGap: CGFloat = 84

  static func isGutter(_ n: LineageNode) -> Bool { !(n.y != nil && n.undated != true && n.type != "commonplace") }

  /// `niceTicks(lo, hi)`: round year ticks between lo and hi (inclusive), at most about six.
  static func niceTicks(_ lo: Int, _ hi: Int) -> [Int] {
    if hi <= lo { return [lo] }
    let span = Double(hi - lo)
    let step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].first { span / Double($0) <= 6 } ?? 1000
    var out = [lo]
    var y = Int((Double(lo) / Double(step)).rounded(.up)) * step
    while y <= hi {
      if Double(y - lo) >= Double(step) / 2 && Double(hi - y) >= Double(step) / 2 { out.append(y) }
      y += step
    }
    out.append(hi)
    return out
  }

  /// `layoutLineage(data, {width, ordinal})`.
  init(_ data: LineageResponse, width: CGFloat, ordinal: Bool) {
    let all = data.nodes
    let dated = all.filter { !Self.isGutter($0) && $0.rootDocument != true }
    let years = Array(Set(dated.compactMap(\.y))).sorted()
    let total = min(Self.maxWidth, max(width, Self.gutter + 2 * Self.pad + CGFloat(years.count) * Self.yearPt))
    let x0 = Self.gutter + Self.pad, x1 = max(x0 + 40, total - Self.pad)
    func xOf(_ y: Int?) -> CGFloat {
      guard let y, !years.isEmpty else { return (x0 + x1) / 2 }
      if ordinal {
        guard years.count > 1, let i = years.firstIndex(of: y) else { return (x0 + x1) / 2 }
        return x0 + CGFloat(i) * (x1 - x0) / CGFloat(years.count - 1)
      }
      let lo = years[0], hi = years[years.count - 1]
      return hi == lo ? (x0 + x1) / 2 : x0 + CGFloat(y - lo) / CGFloat(hi - lo) * (x1 - x0)
    }
    let gens = Array(Set(all.map(\.generation))).sorted { a, b in
      switch (a, b) {
      case (nil, _): false
      case (_, nil): true
      case let (x?, y?): x < y
      }
    }
    var rowOf: [Int?: Int] = [:]
    for (i, g) in gens.enumerated() { rowOf[g] = i }
    let rootNode = all.first { $0.id == data.root }
    var out: [Node] = []
    var gutterCount: [Int: Int] = [:]
    for n in all {
      let row = rowOf[n.generation] ?? 0
      let rootDoc = n.rootDocument == true && rootNode != nil && n.id != rootNode!.id
      let gutter = !rootDoc && Self.isGutter(n)
      let x: CGFloat
      if gutter {
        x = Self.gutter / 2
      } else if rootDoc, let r = rootNode {
        x = Self.isGutter(r) ? Self.gutter / 2 : xOf(r.y)
      } else {
        x = xOf(n.y)
      }
      var y = Self.top + CGFloat(row) * Self.rowHeight + (rootDoc ? 32 : 0)
      if gutter {
        let k = gutterCount[row] ?? 0
        gutterCount[row] = k + 1
        y += CGFloat(k) * 28
      }
      out.append(Node(id: n.id, node: n, x: x, y: y, row: row, gutter: gutter, rootDoc: rootDoc))
    }
    for r in Set(rowOf.values) {
      let idx = out.indices.filter { out[$0].row == r && !out[$0].gutter && !out[$0].rootDoc }.sorted { out[$0].x < out[$1].x }
      for k in idx.indices.dropFirst() where out[idx[k]].x - out[idx[k - 1]].x < Self.minGap {
        out[idx[k]].y += k % 2 == 1 ? Self.stagger : -Self.stagger
      }
    }
    nodes = out
    ticks = ordinal
      ? years.map { Tick(x: xOf($0), label: String($0)) }
      : (years.isEmpty ? [] : Self.niceTicks(years[0], years[years.count - 1]).map { Tick(x: xOf($0), label: String($0)) })
    rows = gens.enumerated().map { RowLine(gen: $0.element, y: Self.top + CGFloat($0.offset) * Self.rowHeight,
                                           label: LineageCopy.hopLabel($0.element)) }
    self.width = total
    height = Self.top + CGFloat(max(1, gens.count)) * Self.rowHeight
  }

  /// `mergeLineage(base, more)`: an expansion merged into the graph (first copy of each node, edge and group wins).
  static func merge(_ base: LineageResponse, _ more: LineageResponse) -> LineageResponse {
    var out = base
    var seenN = Set(base.nodes.map(\.id)), seenE = Set(base.edges.map(\.relId)), seenG = Set(base.groups.map(\.id))
    for n in more.nodes where seenN.insert(n.id).inserted { out.nodes.append(n) }
    for e in more.edges where seenE.insert(e.relId).inserted { out.edges.append(e) }
    for g in more.groups where seenG.insert(g.id).inserted { out.groups.append(g) }
    out.truncated = LineageTruncation(nodes: base.truncated.nodes + more.truncated.nodes,
                                      reason: more.truncated.reason ?? base.truncated.reason)
    return out
  }

  /// `shiftGenerations(payload, baseGen)`: an expansion's rows are relative to the expanded node.
  static func shift(_ payload: LineageResponse, by baseGen: Int) -> LineageResponse {
    var p = payload
    p.nodes = p.nodes.map { n in
      var n = n
      if let g = n.generation { n.generation = g + baseGen }
      return n
    }
    return p
  }
}
