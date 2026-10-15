// OWNER: N5
// Port of server/lineage/path.mjs (SPEC §2.C): the chain of custody — the least-evidence-cost path between two items,
// costing documented 1, computed 3, proposed 5 (rejected links excluded); the chain is as strong as its weakest link.
// Directed links are followed from the later/dependent item to its source (src → dst); undirected ones either way.
// When no chain runs from `from` to `to`, the reverse direction is tried. Dijkstra with the reference's binary heap, so
// ties settle in the same order and the same chain comes back (G3 `g3.lineage`).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

public enum ChainOfCustody {
  public static let cost: [String: Int] = ["documented": 1, "computed": 3, "proposed": 5]
  static let strength = ["proposed", "computed", "documented"]
  /// Nodes a search may settle before it gives up (keeps the query bounded on large graphs).
  public static let nodeBudget = 20_000

  /// path.mjs `MinHeap`: the same sift order (a parent wins ties on the way up; the left child wins ties on the way
  /// down), so equal-cost entries pop in the reference's order.
  struct MinHeap {
    var a: [(ref: String, cost: Int)] = []
    mutating func push(_ x: (ref: String, cost: Int)) {
      a.append(x)
      var i = a.count - 1
      while i > 0 {
        let p = (i - 1) >> 1
        if a[p].cost <= a[i].cost { break }
        a.swapAt(p, i)
        i = p
      }
    }
    mutating func pop() -> (ref: String, cost: Int) {
      let top = a[0]
      let last = a.removeLast()
      if !a.isEmpty {
        a[0] = last
        var i = 0
        while true {
          let l = 2 * i + 1, r = l + 1
          var m = i
          if l < a.count && a[l].cost < a[m].cost { m = l }
          if r < a.count && a[r].cost < a[m].cost { m = r }
          if m == i { break }
          a.swapAt(m, i)
          i = m
        }
      }
      return top
    }
    var isEmpty: Bool { a.isEmpty }
  }

  enum Found {
    case chain([EdgeRow], Int)
    case budget
    case none
  }

  static func search(_ c: Connection, _ f: EdgeFilters, from: String, to: String) throws -> Found {
    var dist: [String: Int] = [from: 0]
    var prev: [String: (ref: String, r: EdgeRow)] = [:]
    var heap = MinHeap()
    heap.push((from, 0))
    var settled = 0
    while !heap.isEmpty {
      let (ref, cost) = heap.pop()
      if cost > dist[ref]! { continue }
      if ref == to { break }
      settled += 1
      if settled > nodeBudget { return .budget }
      let (type, id) = LineageJS.splitRef(ref)
      let out = try Edges.asOf(c, f, try Edges.rows(c, LineageSQL.pathFrom, .text(type), .text(id), f)).map { ($0, $0.dst) }
      let back = try Edges.asOf(c, f, try Edges.rows(c, LineageSQL.undirectedTo, .text(type), .text(id), f)).map { ($0, $0.src) }
      for (r, next) in out + back {
        let step = cost + (Self.cost[r.evidenceStatus] ?? 0)
        if step < (dist[next] ?? Int.max) {
          dist[next] = step
          prev[next] = (ref, r)
          heap.push((next, step))
        }
      }
    }
    guard let total = dist[to] else { return .none }
    var chain: [EdgeRow] = []
    var cur = to
    while cur != from {
      guard let step = prev[cur] else { break }
      chain.insert(step.r, at: 0)
      cur = step.ref
    }
    return .chain(chain, total)
  }

  /// `pathQuery(db, args)`: GET /api/lineage/path?from=&to=&types=&status=&kindred=&runs=&rel_rev_cutoff=.
  public static func query(_ c: Connection, _ args: QueryArgs) throws -> JSONValue {
    let from = args["from"] ?? "", to = args["to"] ?? ""
    for (k, v) in [("from", from), ("to", to)] where !LineageJS.isRef(v) {
      throw ScrollsError.lineageInvalid("\(k) must be a reference like 'passage:77'.", field: k)
    }
    if from == to { throw ScrollsError.lineageInvalid("from and to are the same item.", field: "to") }
    var a = args
    a["rejected"] = "0"
    let f = try EdgeFilters(a)
    var found = try search(c, f, from: from, to: to)
    var reversed = false
    if case .chain = found {} else {
      let back = try search(c, f, from: to, to: from)
      if case .chain = back {
        found = back
        reversed = true
      }
    }
    guard case .chain(let chain, let total) = found else {
      let budget: Bool = if case .budget = found { true } else { false }
      return ["from": .string(from), "to": .string(to), "reversed": false, "path": [], "cost": 0, "weakest": .null,
              "note": .string(budget
                ? "No chain found within \(LineageJS.grouped(nodeBudget)) linked items; narrow the types or statuses."
                : "No chain of recorded links joins these two items (rejected links are excluded).")]
    }
    let path: [JSONValue] = chain.map { r in
      var e = Edges.json(r)
      e["cost"] = .number(Double(Self.cost[r.evidenceStatus] ?? 0))
      return .object(e)
    }
    let weakest = strength.first { s in chain.contains { $0.evidenceStatus == s } }
    return [
      "from": .string(reversed ? to : from),
      "to": .string(reversed ? from : to),
      "reversed": .bool(reversed),
      "path": .array(path),
      "cost": .number(Double(total)),
      "weakest": weakest.map(JSONValue.string) ?? .null,
      "text": .string("Chain strength: weakest link \(weakest.map { $0.uppercased() } ?? "UNDEFINED")."),
    ]
  }
}
