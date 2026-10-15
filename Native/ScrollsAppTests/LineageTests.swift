// OWNER: N5
// The Lineage and Genealogy UI's logic, without the UI (IOS-SPEC §4.11, SPEC §2.C, §2.C2): the explorer's layout (rows
// are hops from the root, the root's document under the root, undated nodes in the gutter, linear vs ordinal time), the
// merge of an expansion, the edge card's words (score kinds are never probabilities, the cue stays proposed, the
// caution is always there), the aligned diff of two spans, the chain of custody's steps, the note rule (≥ 10
// characters), and the models over MockAtlas's contract fixtures.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsService
import Testing

@testable import Scrolls

@MainActor
@Suite("N5 lineage UI logic")
struct LineageTests {
  func node(_ id: String, gen: Int?, y: Int?, undated: Bool = false, rootDoc: Bool = false, type: String = "passage") -> LineageNode {
    var n = LineageNode(id: id, label: y.map(String.init) ?? "undated")
    n.generation = gen
    n.y = y
    n.undated = undated
    n.type = type
    n.rootDocument = rootDoc ? true : nil
    return n
  }

  @Test("layout: rows are hops, the root's document sits under the root, undated nodes go to the gutter")
  func layout() {
    let data = LineageResponse(root: "passage:1", nodes: [
      node("passage:1", gen: 0, y: 1911), node("document:9", gen: 0, y: 1911, rootDoc: true, type: "document"),
      node("passage:2", gen: 1, y: 1963), node("passage:3", gen: 1, y: 1994), node("passage:4", gen: 2, y: nil, undated: true),
    ], edges: [], groups: [], truncated: LineageTruncation(nodes: 0, reason: nil))
    let l = LineageLayout(data, width: 400, ordinal: false)
    let by = Dictionary(uniqueKeysWithValues: l.nodes.map { ($0.id, $0) })
    #expect(by["passage:1"]?.row == 0 && by["passage:2"]?.row == 1 && by["passage:4"]?.row == 2)
    #expect(by["document:9"]?.rootDoc == true && by["document:9"]?.x == by["passage:1"]?.x)
    #expect((by["document:9"]?.y ?? 0) > (by["passage:1"]?.y ?? 0))
    #expect(by["passage:4"]?.gutter == true && by["passage:4"]?.x == LineageLayout.gutter / 2)
    #expect((by["passage:1"]?.x ?? 0) < (by["passage:2"]?.x ?? 0) && (by["passage:2"]?.x ?? 0) < (by["passage:3"]?.x ?? 0))
    #expect(l.rows.map(\.label) == ["root", "+1 hop", "+2 hops"])
    // ordinal: equal width per dated year
    let o = LineageLayout(data, width: 400, ordinal: true)
    let ox = o.nodes.filter { !$0.gutter && !$0.rootDoc }.map(\.x).sorted()
    #expect(abs((ox[1] - ox[0]) - (ox[2] - ox[1])) < 0.001)
    #expect(o.ticks.map(\.label) == ["1911", "1963", "1994"])
  }

  @Test("niceTicks: round years between the ends, at most about six")
  func ticks() {
    #expect(LineageLayout.niceTicks(1911, 2016) == [1911, 1950, 2000, 2016])
    #expect(LineageLayout.niceTicks(1990, 1990) == [1990])
    #expect(LineageLayout.niceTicks(1990, 1994) == [1990, 1991, 1992, 1993, 1994])
  }

  @Test("an expansion merges once per node and edge, generations counted from the root")
  func merge() {
    let base = LineageResponse(root: "passage:1", nodes: [node("passage:1", gen: 0, y: 1911), node("passage:2", gen: 1, y: 1963)],
                               edges: [], groups: [], truncated: LineageTruncation(nodes: 2, reason: "showing 2 nodes — expand or raise max_nodes"))
    let more = LineageResponse(root: "passage:2", nodes: [node("passage:2", gen: 0, y: 1963), node("passage:5", gen: 1, y: 1999)],
                               edges: [], groups: [], truncated: LineageTruncation(nodes: 1, reason: nil))
    let m = LineageLayout.merge(base, LineageLayout.shift(more, by: 1))
    #expect(m.nodes.map(\.id) == ["passage:1", "passage:2", "passage:5"])
    #expect(m.nodes.first { $0.id == "passage:5" }?.generation == 2)
    #expect(m.nodes.first { $0.id == "passage:2" }?.generation == 1, "the base copy wins")
    #expect(m.truncated.nodes == 3)
  }

  @Test("edge card words: score kinds are never probabilities; the caution; the cue stays proposed")
  func edgeCard() async throws {
    let r = try await MockAtlas().relationship(RelationshipID(rawValue: 7811))
    let c = EdgeCardContent(r)
    #expect(c.heading.contains("Verse, 2017"))
    #expect(!c.origin.isEmpty)
    #expect(r.caution == LineageCopy.caution)
    #expect(LineageCopy.score(0.71, kind: "similarity") == "similarity 0.71 — not a probability")
    #expect(LineageCopy.score(0.4, kind: "heuristic_strength") == "Cipher heuristic weight 0.4 — not a probability")
    for kind in Vocab.scoreKinds { #expect(LineageCopy.score(0.5, kind: kind).hasSuffix("— not a probability")) }
    #expect(LineageCopy.origin("human", createdBy: "human:Reader A", dataset: nil, method: nil, run: nil) == "proposed by a person: Reader A")
    #expect(LineageCopy.origin("algorithm", createdBy: "run:7", dataset: nil, method: nil, run: 7) == "computed by an algorithm (run 7)")
  }

  @Test("the aligned diff keeps shared words and marks substitutions, insertions and omissions")
  func diff() {
    let ops = EdgeCardContent.alignTokens("Carry the zero, keep the column", "carry the ZERO and keep its column")
    #expect(ops.first == .same("Carry", "carry"))
    #expect(ops.contains(.same("zero,", "ZERO")))
    #expect(ops.contains(.ins("and")) || ops.contains(.sub("zero,", "and")))
    #expect(ops.contains(.sub("the", "its")))
    #expect(EdgeCardContent.alignTokens("", "a b") == [.ins("a"), .ins("b")])
  }

  @Test("a review or evidence note needs at least 10 characters")
  func notes() {
    #expect(LineageCopy.noteProblem("too short") == "A note needs at least 10 characters (9 so far).")
    #expect(LineageCopy.noteProblem("   checked the 1911 edition  ") == nil)
  }

  @Test("chain of custody: steps from the path, the weakest link's words")
  func chain() async throws {
    let p = try await MockAtlas().lineagePath(LineagePathRequest(from: "passage:2210", to: "passage:77"))
    let steps = ChainOfCustodyView.steps(p.path)
    #expect(steps.map(\.cost) == [5, 1])
    #expect(p.weakest == "proposed" && p.text == "Chain strength: weakest link PROPOSED.")
  }

  @Test("the explorer model loads, cycles the evidence filter, and picks a chain over MockAtlas")
  func explorerModel() async {
    let m = LineageModel(root: "passage:77", atlas: MockAtlas())
    await m.load()
    #expect(m.error == nil)
    #expect((m.data?.nodes.count ?? 0) > 1)
    #expect(m.request().status == nil)
    m.statusMode = m.statusMode.next
    #expect(m.request().status == "documented,computed")
    m.statusMode = m.statusMode.next
    #expect(m.request().status == "documented")
    #expect(m.visibleEdges.allSatisfy { $0.evidenceStatus == "documented" })
    m.chainMode = true
    await m.pick("passage:2210")
    await m.pick("passage:77")
    #expect(m.path?.weakest == "proposed")
  }

  @Test("genealogy: the honesty note is always there; the time axis covers every row")
  func genealogy() async {
    let g = GenealogyModel(work: "document:30", atlas: MockAtlas())
    await g.load()
    let d = try? #require(g.data)
    #expect(d?.note.contains("Absence of a link is not evidence of no sampling.") == true)
    if let d {
      let axis = GenealogyLayout(d)
      #expect(axis.lo <= 1952 && axis.hi >= 1994)
      #expect(GenealogyLayout.year(["label": "17 May 1994"]) == 1994)
      #expect(GenealogyLayout.year(["label": "undated"]) == nil)
    }
  }
}
