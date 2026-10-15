// OWNER: N0
// The one-presentation rule (IOS-SPEC §4.2), driven through every pair — and every triple — of coordinator
// transitions; the inspector's detent geometry and velocity snap; scene-storage encoding of routes; launch-argument
// parsing; and the strings of the shared evidence components (gate card, denominator line, counting label, date chip,
// status chip, self-test status), which must never show a bare count or a numeral for a gated measure; and the frozen
// Scroll-model contract the shell owns (time scale, tiers, the vantage predicate of `display.mjs`).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel
import Testing

@testable import Scrolls

// MARK: - Presentation coordinator

@MainActor
@Suite("Presentation: at most one system presentation")
struct PresentationTests {
  /// Every operation the shell performs on the coordinator.
  enum Action: CaseIterable {
    case pushCompare, pushNotebook, pop, popToRoot
    case presentSources, presentDiagnostics, showEdge, showNode
    case dismissAll, cardDidDismiss, modalDidDismiss

    func apply(_ c: PresentationCoordinator) {
      switch self {
      case .pushCompare:
        c.push(.compare(CompareSeed(SliceSeed(fromYear: 1840, toYear: 1899), SliceSeed(fromYear: 1990, toYear: 2026),
                                    viewHash: "v=1")))
      case .pushNotebook: c.push(.notebook(NotebookSeed(target: nil)))
      case .pop: c.pop()
      case .popToRoot: c.popToRoot()
      case .presentSources: c.present(.sources)
      case .presentDiagnostics: c.present(.diagnostics)
      case .showEdge: c.show(.edge(RelationshipID(rawValue: 7)))
      case .showNode: c.show(.node(NodeRef(kind: "document", id: 3)))
      case .dismissAll: c.dismissAll()
      case .cardDidDismiss: c.cardDidDismiss()
      case .modalDidDismiss: c.modalDidDismiss()
      }
    }
  }

  /// The invariants of §4.2 that must hold after any transition.
  private func checkInvariants(_ c: PresentationCoordinator, after trail: [Action]) {
    let context = Comment(rawValue: "after \(trail)")
    #expect(!(c.modal != nil && c.card != nil), context)
    #expect(c.card == nil || !c.path.isEmpty, "a card only on a pushed destination; \(context)")
    #expect(c.pendingModal == nil || (c.card == nil && c.modal == nil), "a pending modal waits for nothing else; \(context)")
    if c.canShowPopover {
      #expect(c.path.isEmpty && c.modal == nil && c.card == nil, context)
    }
    #expect(c.isPresenting == (c.modal != nil || c.card != nil), context)
  }

  @Test("every pair of transitions keeps one presentation at most")
  func everyPair() {
    for a in Action.allCases {
      for b in Action.allCases {
        let c = PresentationCoordinator()
        a.apply(c)
        checkInvariants(c, after: [a])
        b.apply(c)
        checkInvariants(c, after: [a, b])
      }
    }
  }

  @Test("every triple of transitions keeps one presentation at most")
  func everyTriple() {
    for a in Action.allCases {
      for b in Action.allCases {
        for d in Action.allCases {
          let c = PresentationCoordinator()
          for (i, step) in [a, b, d].enumerated() {
            step.apply(c)
            checkInvariants(c, after: Array([a, b, d].prefix(i + 1)))
          }
        }
      }
    }
  }

  @Test("a modal presented over a card waits for the card to go")
  func modalOverCard() {
    let c = PresentationCoordinator()
    Action.pushCompare.apply(c)
    #expect(c.show(.edge(RelationshipID(rawValue: 1))))
    c.present(.sources)
    #expect(c.card == nil)
    #expect(c.modal == nil)
    #expect(c.pendingModal == .sources)
    c.cardDidDismiss()
    #expect(c.modal == .sources)
    #expect(c.pendingModal == nil)
  }

  @Test("cards are refused on the root and under a modal")
  func cardRules() {
    let c = PresentationCoordinator()
    #expect(!c.show(.node(NodeRef(kind: "passage", id: 9))))
    #expect(c.card == nil)
    Action.pushNotebook.apply(c)
    c.present(.legend)
    #expect(!c.show(.node(NodeRef(kind: "passage", id: 9))))
    c.modalDidDismiss()
    #expect(c.show(.node(NodeRef(kind: "passage", id: 9))))
  }

  @Test("pushing closes every presentation; popping takes the card with it")
  func pushAndPop() {
    let c = PresentationCoordinator()
    c.present(.settings)
    Action.pushCompare.apply(c)
    #expect(c.modal == nil && c.path.count == 1)
    #expect(c.show(.edge(RelationshipID(rawValue: 2))))
    c.pop()
    #expect(c.card == nil && c.path.isEmpty)
    #expect(c.canShowPopover)
  }

  @Test("only the top destination sees the card")
  func cardBindingFollowsTop() {
    let c = PresentationCoordinator()
    let first = Route.notebook(NotebookSeed(target: nil))
    let second = Route.lineage(LineageSeed(root: NodeRef(kind: "document", id: 4)))
    c.push(first)
    c.push(second)
    c.show(.edge(RelationshipID(rawValue: 5)))
    #expect(c.cardBinding(for: second).wrappedValue == .edge(RelationshipID(rawValue: 5)))
    #expect(c.cardBinding(for: first).wrappedValue == nil)
  }

  @Test("the route stack survives scene storage (Codable round trip)")
  func routesRoundTrip() throws {
    let path: [Route] = [
      .compare(CompareSeed(SliceSeed(fromYear: 1990, toYear: 2026, filter: "lang:en"), SliceSeed(fromYear: 1840, toYear: 1899),
                           viewHash: "v=1&c=demo")),
      .lineage(LineageSeed(root: NodeRef(kind: "document", id: 12))),
      .genealogy(GenealogySeed(work: NodeRef(kind: "document", id: 99))),
      .constellation(ConstellationSeed(expression: 12, query: "zero", periodA: [1900, 1909], periodB: nil)),
      .notebook(NotebookSeed(target: AnnotationTarget(type: "passage", id: 901))),
    ]
    let data = try JSONEncoder().encode(path)
    #expect(try JSONDecoder().decode([Route].self, from: data) == path)
  }

  @Test("Compare seeds put the earlier slice first")
  func compareOrder() {
    let seed = CompareSeed(SliceSeed(fromYear: 1990, toYear: 2026), SliceSeed(fromYear: 1840, toYear: 1899), viewHash: "")
    #expect(seed.a.fromYear == 1840)
    #expect(seed.b.fromYear == 1990)
  }
}

// MARK: - Inspector detents

@Suite("Inspector detents (430 × 932 pt, insets 59/34)")
struct SheetDetentTests {
  let layout = SheetLayout(containerHeight: 932, safeTop: 59, safeBottom: 34)

  @Test("heights match §4.3: lanes keep 615 pt at peek and 287 pt at half")
  func heights() {
    #expect(layout.height(.peek) == 138)
    #expect(layout.height(.half) == 466)
    #expect(layout.height(.large) == 829)
    // The lanes run from y = 179 (below TopBar, ribbon, minimap, ruler and coverage) to the sheet's top edge.
    #expect(932 - layout.height(.peek) - 179 == 615)
    #expect(932 - layout.height(.half) - 179 == 287)
  }

  @Test("a slow release settles on the nearest detent")
  func nearest() {
    #expect(layout.snap(from: .peek, height: 300, velocity: 0) == .peek)
    #expect(layout.snap(from: .peek, height: 320, velocity: 0) == .half)
    #expect(layout.snap(from: .half, height: 700, velocity: 0) == .large)
  }

  @Test("a flick moves at least one detent in its direction")
  func flicks() {
    #expect(layout.snap(from: .peek, height: 150, velocity: -1_200) == .half)
    #expect(layout.snap(from: .large, height: 800, velocity: 1_200) == .half)
    #expect(layout.snap(from: .peek, height: 140, velocity: 1_200) == .peek)
  }

  @Test("drags past the outer detents rubber-band at 0.55")
  func rubberBand() {
    #expect(layout.rubberBanded(118) == 138 - 20 * 0.55)
    #expect(layout.rubberBanded(849) == 829 + 20 * 0.55)
    #expect(layout.rubberBanded(400) == 400)
  }

  @Test("accessibility sizes grow the peek row")
  func accessibilityPeek() {
    let big = SheetLayout(containerHeight: 932, safeTop: 59, safeBottom: 34, peekContent: 144)
    #expect(big.height(.peek) == 178)
  }
}

// MARK: - Launch arguments

@Suite("Launch arguments")
struct LaunchArgsTests {
  @Test("the device-check launch line parses")
  func deviceCheckLine() {
    let a = LaunchArgs.parse(["Scrolls", "-selftest", "probe", "-atlasRoot", "selftest", "-perf"])
    #expect(a.selfTest == .probe)
    #expect(a.atlasRoot == "selftest")
    #expect(a.perf)
    #expect(a.problems.isEmpty)
    #expect(a.summary == ["-perf", "-selftest probe", "-atlasRoot selftest"])
  }

  @Test("every suite name parses, including first-minute")
  func suites() {
    for suite in SelfTestSuite.allCases {
      #expect(LaunchArgs.parse(["Scrolls", "-selftest", suite.rawValue]).selfTest == suite)
    }
  }

  @Test("LabKit's fake conditions: -fakeThermal without a value means serious")
  func fakes() {
    #expect(LaunchArgs.parse(["Scrolls", "-fakeThermal"]).fakeThermal == 2)
    #expect(LaunchArgs.parse(["Scrolls", "-fakeThermal", "3", "-fakeLowPower"]).fakeThermal == 3)
    #expect(LaunchArgs.parse(["Scrolls", "-fakeLowPower"]).fakeLowPower)
    #expect(LaunchArgs.parse(["Scrolls", "-fakeThermal", "7"]).problems.count == 1)
  }

  @Test("UI tests always run on fixtures; bad values are reported, not guessed")
  func engineChoice() {
    #expect(LaunchArgs.parse(["Scrolls", "-ui-testing"]).effectiveEngine == .fixtures)
    #expect(LaunchArgs.parse(["Scrolls", "-engine", "fixtures"]).effectiveEngine == .fixtures)
    #expect(LaunchArgs.parse(["Scrolls"]).effectiveEngine == .live)
    let bad = LaunchArgs.parse(["Scrolls", "-selftest", "everything", "-atlasRoot", "../Notebook", "-renderer", "gl"])
    #expect(bad.selfTest == nil && bad.atlasRoot == nil && bad.renderer == .metal)
    #expect(bad.problems.count == 3)
  }

  @Test("system and XCTest arguments pass through")
  func passThrough() {
    let a = LaunchArgs.parse(["Scrolls", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
                              "-corpus", "cipher", "-strand", "zero", "-renderer", "canvas", "-tour", "-tourStep", "3"])
    #expect(a.corpus == "cipher" && a.strand == "zero" && a.renderer == .canvas && a.tour && a.tourStep == 3)
    #expect(a.problems.isEmpty)
  }
}

// MARK: - Shared components: words from numbers, never a bare count

@Suite("Shared evidence components")
struct ComponentStringTests {
  @Test("gate card words (gate-card.mjs)")
  func gateCard() {
    let m = GateCardModel(gate: "insufficient_coverage", needed: ["tokens_per_slice": 3_000_000],
                          have: ["a": 21_400, "b": 30_100], suggestion: .null, note: nil)
    #expect(m.gateWords == "too little coverage")
    #expect(m.needed == "≥ 3,000,000 tokens per slice")
    #expect(m.have == "A 21,400 tokens · B 30,100 tokens")
    #expect(m.suggestion == GateCardCopy.noWidening)
    #expect(!m.applicable)

    let widen = GateCardModel(gate: "slice_too_small", needed: ["occurrences_per_slice": 50],
                              have: ["a": ["occurrences": 7, "documents": 2], "b": ["occurrences": 61, "documents": 9]],
                              suggestion: ["a": ["years": [1840, 1899]], "b": ["years": [1990, 2026]]], note: nil)
    #expect(widen.have == "A 2 documents, 7 occurrences · B 9 documents, 61 occurrences")
    #expect(widen.suggestion == "Widen to A 1840–1899 · B 1990–2026")
    #expect(widen.applicable)

    let run = GateCardModel(gate: "not_run", needed: nil, have: nil,
                            suggestion: ["run": ["stage": "cluster"]], note: "Context groups need a clustering run.")
    #expect(run.suggestion == "Run a clustering run first")
    #expect(run.have == "none")
    #expect(run.needed.isEmpty)
  }

  @Test("every gate code has words")
  func gateWords() {
    for code in Vocab.gateCodes where code != "ok" {
      #expect(GateCardCopy.gateWords[code] != nil, "no words for \(code)")
    }
  }

  @Test("a denominator line always names its denominator")
  func denominator() {
    #expect(Denominator(n: 37, window: "1925–1945", denominator: 6_100_000, unit: "tokens").text
            == "n = 37 in 1925–1945 · 6.1M tokens")
    #expect(Denominator(n: 3, window: nil, denominator: nil, unit: "tokens").text == "n = 3 · denominator not counted")
    var observed = Denominator(n: 14, window: "1910–1919", denominator: 38_120, unit: "tokens", documents: 1)
    observed.rate = 367.3
    observed.rateUnit = "per_million_tokens"
    observed.ci = [201, 616]
    #expect(observed.text.hasPrefix("n = 14 in 1910–1919 · 38.1k tokens · 1 document · 367"))
    #expect(observed.text.hasSuffix("[201, 616]"))
  }

  @Test("counting labels show a number or words, never a spinner")
  func counting() {
    #expect(CountingLabel.text("counting…", fraction: 0.41) == "counting… 41%")
    #expect(CountingLabel.text("counting…", fraction: nil) == "counting…")
    #expect(CountingLabel.text("indexing", fraction: 1.7) == "indexing 100%")
    #expect(StatusChipState.progress("Cipher", 0.45).text == "Cipher 45%")
    #expect(StatusChipState.paused("paused: phone is hot").text == "paused: phone is hot")
  }

  @Test("date chip (date-chip.mjs)")
  func dateChip() {
    let stated = DateChipModel(label: "17 May 1994", precision: "day", basis: "stated", role: "publication", notes: [])
    #expect(stated.text == "17 May 1994 · stated · day")
    #expect(stated.glyph == nil)
    #expect(stated.roleLabel == "publication")
    let estimated = DateChipModel(label: "c. 1894", precision: "decade", basis: "estimated", role: nil,
                                  notes: ["Year from an unverified list"], isTranslation: true)
    #expect(estimated.glyph == "≈")
    #expect(estimated.flags == [DateChipCopy.unverifiedFlag, DateChipCopy.translationFlag])
    let undated = DateChipModel(json: nil)
    #expect(undated.text == "undated")
    #expect(undated.accessibilityLabel == "Undated: outside chronology")
  }

  @Test("error cards keep the engine's words and suggest narrowing on a timeout")
  func errorCard() {
    let e = ScrollsError(code: .queryTimeout, message: "The read took longer than 5 s.", hint: nil)
    let m = ErrorCardModel(e)
    #expect(m.code == "QUERY_TIMEOUT")
    #expect(m.hint == ErrorCardCopy.narrow)
  }

  @Test("evidence badges list status, conflict, review and synthetic words")
  func badges() {
    let style = EvidenceStyle.style(EvidenceStyleKey(evidenceStatus: "computed", reviewStatus: "disputed",
                                                    isSynthetic: true, dateConflict: true))
    #expect(EvidenceBadge.keys(for: style) == ["CALC", "⚠", "⚖", "SYN"])
    for key in EvidenceBadge.keys(for: style) { #expect(Copy.badges[key] != nil) }
  }

  @Test("self-test status: PASS only when every row passes or informs")
  func selfTestStatus() {
    #expect(SelfTestResult.status(of: [.pass("a", ""), .info("b", "")]) == .pass)
    #expect(SelfTestResult.status(of: [.pass("a", ""), .pending("b", "")]) == .pending)
    #expect(SelfTestResult.status(of: [.fail("a", ""), .pending("b", "")]) == .fail)
    #expect(SelfTestResult.status(of: []) == .pending)
  }

  @Test("self-test run folders are UTC yyyyMMdd'T'HHmmss'Z' (device-check.sh sorts on them)")
  func runName() {
    #expect(SelfTestRunner.runName(Date(timeIntervalSince1970: 1_791_000_000)) == "20261003T040000Z")
  }
}

// MARK: - The Scroll-model contract (TimeScale, Tier, Vantage)

@Suite("Scroll model contract")
struct ScrollModelContractTests {
  @Test("tiers start where tiers.mjs says (dates.tierForPpy)")
  func tiers() {
    let cases: [(Double, Tier)] = [(0.05, .millennia), (0.0799, .millennia), (0.08, .centuries), (0.8, .decades),
                                   (7.99, .decades), (8, .years), (96, .months), (2921, .months), (2922, .days)]
    for (ppy, tier) in cases { #expect(Tier(pointsPerYear: ppy) == tier, "\(ppy) pt/yr") }
    for tier in Tier.allCases {
      #expect(Tier(code: tier.code) == tier)
      #expect(Tier(pointsPerYear: tier.midPointsPerDay * TimeScale.daysPerYear) == tier, "mid zoom of \(tier.code)")
    }
    #expect(Tier.millennia.coarser == .millennia && Tier.days.finer == .days)
    #expect(Tier.decades.binPlural == "decades" && Tier.years.binAdjective == "yearly")
  }

  @Test("x and day are inverse; a pinch keeps the day under the fingers")
  func timeScale() {
    let s = TimeScale(centerDay: 0, pointsPerDay: 0.01, width: 430)
    #expect(abs(s.x(day: s.day(x: 123)) - 123) < 1e-9)
    #expect(abs(s.x(day: s.centerDay) - 215) < 1e-9)
    let z = s.zoomed(by: 3, around: 100)
    #expect(abs(z.day(x: 100) - s.day(x: 100)) < 1e-6)
    #expect(z.pointsPerDay == 0.03)
    #expect(s.zoomed(by: 1e12, around: 0).pointsPerDay == TimeScale.maxPointsPerDay)
    #expect(s.zoomed(by: 1e-12, around: 0).pointsPerDay == TimeScale.minPointsPerDay)
    #expect(s.panned(by: 1e12).centerDay == TimeScale.domain.lowerBound)
    #expect(TimeScale(centerDay: 0, daysPerPoint: 75, width: 430).pointsPerDay == 1.0 / 75)
  }

  @Test("the vantage predicate equals display.mjs vantageState")
  func vantage() {
    let strict = Vantage(day: 100, mode: .strict)
    let context = Vantage(day: 100, mode: .context)
    #expect(visibility(revealDay: 500, at: nil) == .show)
    #expect(visibility(revealDay: 100, at: strict) == .show)
    #expect(visibility(revealDay: 101, at: strict) == .hide)
    #expect(visibility(revealDay: 101, at: context) == .ghost)
    #expect(visibility(revealDay: alwaysRevealed, at: strict) == .show)
    #expect(Vantage(ViewState.Vantage(day: -700_000, strict: false)) == Vantage(day: -700_000, mode: .context))
  }
}
