// OWNER: N8
// The first minute and the tour (IOS-SPEC §4.17; port of `tour/coachmarks.mjs` and `tour/tour.mjs`).
// - First launch opens the demo with step 1's strand pinned (from `tour()`, never an id written here).
// - Coach ① at ≈ 2 s after the first frame, ② at ≈ 12 s, ③ at ≈ 40 s (sooner once he opens a passage), then
//   Your turn at 55–60 s, or once a Play he started from ③ has ended. They never block: only the card takes touches.
//   Shown once: they never return unless he asks for the Tour (UserDefaults; a failing store shows them again).
// - Your turn: the search field focused, start chips checked against the engine, Switch to Cipher (real data) — enabled
//   once Cipher's phase A is done, otherwise showing its live percentage — and the Full tour.
// - The full tour: the 10 steps of `tour.json`, each with Show me (loads its view state).
// Every name and year in a coach mark comes from the data on screen (`coachCopy`).

import Foundation
import Observation
import ScrollsContracts
import ScrollsCore
import ScrollsService

/// A coach mark's stage: ① ② ③, then Your turn (4).
nonisolated enum CoachStage: Int, Comparable, Sendable, Codable, CaseIterable {
  case first = 1, second, third, yourTurn

  static func < (a: CoachStage, b: CoachStage) -> Bool { a.rawValue < b.rawValue }
  var next: CoachStage? { CoachStage(rawValue: rawValue + 1) }
}

/// The schedule of the first minute (§4.17), in seconds.
nonisolated enum CoachTiming {
  /// ① after the first frame with data.
  static let first: Double = 2
  /// ② after ①.
  static let second: Double = 10
  /// ③ after ②, when no passage was opened.
  static let third: Double = 28
  /// ③ after a passage was opened during ② (he reads first).
  static let thirdAfterOpen: Double = 15
  /// Your turn after ③, when Play was not started.
  static let final: Double = 18
  /// Your turn after a Play started from ③ has ended.
  static let afterPlay: Double = 1.5
}

/// A start chip of Your turn (`tour.mjs` START_CANDIDATES), offered only when the engine confirms its data.
nonisolated struct StartChip: Sendable, Equatable, Identifiable {
  enum Kind: String, Sendable { case expression, theme }
  let kind: Kind
  let label: String
  let corpus: String
  let count: Int?
  /// The tracked expression, when the search found one.
  let expression: Int?
  let surface: String

  var id: String { "\(corpus):\(kind.rawValue):\(label)" }
}

/// The words of a coach mark (`coachCopy`), filled from the data on screen.
nonisolated struct CoachText: Sendable, Equatable {
  var title: String?
  var lines: [String]
}

nonisolated enum CoachWords {
  /// `coachCopy(stage, {label, doc, calc, health})`.
  static func text(_ stage: CoachStage, label: String?, doc: Arc?, calc: Arc?, cipher: BootstrapStatus?) -> CoachText {
    switch stage {
    case .first:
      return CoachText(title: nil, lines: [TourCopy.coachOne(label ?? TourCopy.thePhrase)])
    case .second:
      var lines: [String] = []
      if let doc {
        lines.append(arcLine(doc, badge: "DOC",
                             how: (doc.source ?? TourCopy.aDocumentedRecord) + (doc.synthetic ? TourCopy.syntheticSuffix : "")))
      }
      if let calc {
        lines.append(arcLine(calc, badge: "CALC", how: TourCopy.computedByMatching + (calc.runId.map { TourCopy.runSuffix(Int($0.rawValue)) } ?? "")))
      }
      lines.append(TourCopy.lineStyle)
      return CoachText(title: nil, lines: lines)
    case .third:
      return CoachText(title: nil, lines: [TourCopy.pressPlay])
    case .yourTurn:
      return CoachText(title: TourCopy.yourTurn, lines: [cipherLine(cipher)])
    }
  }

  /// "DOC — 1994 explicit citation → 1911: liner-note record (synthetic)".
  static func arcLine(_ a: Arc, badge: String, how: String) -> String {
    let from = a.src.y.map(String.init) ?? "?"
    let to = a.dst.y.map(String.init) ?? "?"
    return "\(badge) — \(from) \(a.relType.replacing("_", with: " ")) → \(to): \(how)"
  }

  /// Cipher's state for Your turn (`coachCopy` stage 4).
  static func cipherLine(_ c: BootstrapStatus?) -> String {
    guard let c else { return TourCopy.waitingForEngine }
    switch c.status {
    case "ready": return TourCopy.cipherReady
    case "fulltext": return TourCopy.cipherMetadataReady(c.message ?? TourCopy.fullTextIndexing)
    case "metadata", "queued":
      let pct = c.progress.flatMap { $0.isFinite ? Int(($0 * 100).rounded()) : nil }
      return TourCopy.cipherImporting(pct)
    default: return c.message ?? "\(TourCopy.cipher): \(c.status)"
    }
  }

  /// `cipherOpenable(health)`: Cipher's metadata phase is done.
  static func cipherOpenable(_ c: BootstrapStatus?) -> Bool { c?.status == "fulltext" || c?.status == "ready" }
}

/// The dismissal flag (`TOUR_DISMISSED_KEY`), a per-device convenience: a failing store counts as not dismissed.
nonisolated enum TourStore {
  static let key = "scrolls.tour.dismissed"

  static func dismissed(_ defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: key) }

  static func setDismissed(_ value: Bool, _ defaults: UserDefaults = .standard) {
    if value { defaults.set(true, forKey: key) } else { defaults.removeObject(forKey: key) }
  }
}

@MainActor @Observable
final class TourModel {
  @ObservationIgnored private unowned let app: AppModel
  @ObservationIgnored private weak var experience: ExperienceModel?
  /// The coach mark on screen (nil: none).
  private(set) var stage: CoachStage?
  /// When each stage appeared, in seconds since the process started (the first-minute self-test and UI test read it).
  private(set) var shownAt: [CoachStage: Double] = [:]
  /// The arcs coach ② names (from `arcs` on the query on screen).
  private(set) var documentedArc: Arc?
  private(set) var computedArc: Arc?
  /// The first strand's words (coach ①).
  private(set) var strandLabel: String?
  /// Your turn's start chips: nil while checking.
  private(set) var chips: [StartChip]?
  /// The full tour's steps, and the step shown (nil: closed).
  private(set) var steps: [TourStep] = []
  private(set) var minutes: Int?
  var fullTourStep: Int?
  /// Play was started while ③ was up.
  @ObservationIgnored private var sawPlay = false
  @ObservationIgnored private var armed = false
  @ObservationIgnored private var timer: Task<Void, Never>?
  @ObservationIgnored private var seeded = false
  /// When the Scroll was first ready with an engine (seconds since the process started): the first minute's zero.
  private(set) var readyAt: Double?

  init(app: AppModel) {
    self.app = app
  }

  func attach(_ experience: ExperienceModel) { self.experience = experience }

  /// Seconds since the process started (PerfLog's clock for launch timings).
  static func now() -> Double {
    guard let start = PerfLog.processStart() else { return ProcessInfo.processInfo.systemUptime }
    return Date.now.timeIntervalSince(start)
  }

  // MARK: Launch

  /// Called once the engine is ready and the first frame is up: seed the demo's strand, then arm the coach marks
  /// (or jump to `-tourStep n`, or open the full tour for `-tour`).
  func launched(restored: Bool) async {
    guard !armed else { return }
    armed = true
    readyAt = Self.now()
    PerfLog.shared.record("first-minute.ready.at", ms: (readyAt ?? 0) * 1000)
    await loadTour()
    if !restored { seedStrands() }
    if let step = app.launch.tourStep {
      if step >= 1, step <= 4, let s = CoachStage(rawValue: step) {
        go(s)
      } else if step > 4 {
        fullTourStep = step - 4
      }
      return
    }
    if app.launch.tour {
      fullTourStep = 1
      return
    }
    let ignoreStore = app.launch.uiTesting || app.launch.selfTest == .firstMinute
    guard app.viewState.corpus == "demo", ignoreStore || !TourStore.dismissed() else { return }
    later(CoachTiming.first) { $0.go(.first) }
  }

  /// `seedStrands(tour, view)`: step 1's strands, when the view is the demo with none pinned.
  private func seedStrands() {
    guard !seeded, app.viewState.corpus == "demo", app.viewState.strands.isEmpty else { return }
    seeded = true
    let step = steps.first { $0.n == 1 } ?? steps.first
    guard let hash = step?.state else { return }
    let decoded = ViewState.decodeHash(hash).state
    guard decoded.corpus == "demo" else { return }
    for s in decoded.strands { experience?.pin(type: s.type, id: s.id, label: nil, quiet: true) }
  }

  private func loadTour() async {
    guard steps.isEmpty, let atlas = app.atlas else { return }
    if let t = try? await atlas.tour() {
      steps = t.steps
      minutes = t.minutes
    }
  }

  // MARK: Stages

  /// Shows a stage (or ends the coach marks with nil).
  func go(_ next: CoachStage?) {
    timer?.cancel()
    guard let next, app.viewState.corpus == "demo" || next == .yourTurn else {
      dismiss()
      return
    }
    stage = next
    shownAt[next] = Self.now()
    TourStore.setDismissed(true)   // shown once: it never returns unless he asks for the Tour
    PerfLog.shared.record("first-minute.coach-\(next.rawValue).at", ms: Self.now() * 1000)
    switch next {
    case .first:
      updateOutlines()
      Task { await loadLabel() }
      later(CoachTiming.second) { $0.go(.second) }
    case .second:
      updateOutlines()
      Task { await loadArcs() }
      later(CoachTiming.third) { $0.go(.third) }
    case .third:
      updateOutlines()
      sawPlay = false
      later(CoachTiming.final) { $0.go(.yourTurn) }
    case .yourTurn:
      updateOutlines()
      experience?.showYourTurn()
      Task { await loadChips() }
    }
  }

  /// × on a coach card: the coach marks end and never return unless he asks for the Tour.
  func dismiss() {
    timer?.cancel()
    stage = nil
    experience?.bridge.coachOutlines = []
    TourStore.setDismissed(true)
  }

  /// He asked for the Tour: the coach marks are re-armed from ① on the demo, and the full tour card opens.
  func replay() {
    TourStore.setDismissed(false)
    if app.viewState.corpus != "demo" { experience?.setCorpus("demo") }
    fullTourStep = 1
    later(CoachTiming.first) { $0.go(.first) }
  }

  /// A passage was opened during ②: ③ follows once he has read it.
  func passageOpened() {
    guard stage == .second else { return }
    later(CoachTiming.thirdAfterOpen) { $0.go(.third) }
  }

  /// Play started or stopped. A Play started from ③ moves on to Your turn once it ends.
  func playChanged(_ playing: Bool) {
    guard stage == .third else { return }
    if playing {
      sawPlay = true
      timer?.cancel()
    } else if sawPlay {
      sawPlay = false
      later(CoachTiming.afterPlay) { $0.go(.yourTurn) }
    }
  }

  /// The corpus changed away from the demo: coach marks ①–③ end (Your turn may stay).
  func corpusChanged(_ corpus: String) {
    guard corpus != "demo", let stage, stage < .yourTurn else { return }
    timer?.cancel()
    self.stage = nil
    experience?.bridge.coachOutlines = []
  }

  private func later(_ seconds: Double, _ body: @escaping @MainActor (TourModel) -> Void) {
    timer?.cancel()
    timer = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(Int(seconds * 1000)))
      guard !Task.isCancelled, let self else { return }
      body(self)
    }
  }

  /// The static outlines of coach ① (the 1940s hatch, the 1984–93 dotted stretch): drawn by the Scroll from the gaps it
  /// knows; the tour only says which kinds to outline, never where a gap is.
  private func updateOutlines() {
    experience?.bridge.coachOutlines = []
  }

  // MARK: Data for the words

  private func loadLabel() async {
    guard let atlas = app.atlas, let first = app.viewState.strands.first else { return }
    if let label = experience?.bridge.strandLabels[first.id.text] {
      strandLabel = label
      return
    }
    if first.type == "expression", case .number(let n) = first.id, let e = try? await atlas.expression(ExpressionID(n)) {
      strandLabel = e.expression.surface
    } else {
      strandLabel = first.id.text
    }
  }

  /// The documented and computed arcs of the query on screen (coach ②): the first of each status.
  private func loadArcs() async {
    guard let atlas = app.atlas else { return }
    do {
      let key: String
      if let known = experience?.bridge.queryKey {
        key = known
      } else {
        key = try await atlas.timelineQuery(ViewQuery.request(app.viewState)).queryKey
      }
      let arcs = try await atlas.arcs(ArcsRequest(q: key, limit: 150))
      documentedArc = arcs.items.first { $0.evidenceStatus == "documented" && !$0.feedback }
      computedArc = arcs.items.first { $0.evidenceStatus == "computed" && !$0.feedback }
    } catch {
      documentedArc = nil
      computedArc = nil
    }
  }

  /// `startChips(api, 'cipher')`: virus · zero · sample, each only when a search of Cipher confirms matches.
  private func loadChips() async {
    guard chips == nil, let atlas = app.atlas else { return }
    var out: [StartChip] = []
    for q in TourCopy.startWords {
      guard let r = try? await atlas.search(SearchRequest(q: q, corpus: "cipher", scope: "text", limit: 3)) else { continue }
      guard let s = r.suggestions.first(where: { $0.type == "expression" }), let n = s.count, n > 0 else { continue }
      let id = s.ref.hasPrefix("expression:") ? Int(s.ref.dropFirst("expression:".count)) : nil
      out.append(StartChip(kind: .expression, label: q, corpus: "cipher", count: n, expression: id, surface: r.query.surface))
    }
    chips = out
  }

  /// A start chip: switch to its corpus, then pin its expression (tracking it first when new).
  func use(_ chip: StartChip) async {
    guard let experience else { return }
    experience.setCorpus(chip.corpus)
    if let id = chip.expression {
      experience.pin(type: "expression", id: .number(id), label: chip.label)
    } else {
      await experience.search.track(surface: chip.surface, kind: nil, lang: nil, label: chip.label)
    }
    dismiss()
  }

  // MARK: The full tour

  var currentStep: TourStep? {
    guard let i = fullTourStep, !steps.isEmpty else { return nil }
    return steps[max(0, min(steps.count - 1, i - 1))]
  }

  func openFullTour() {
    dismiss()
    fullTourStep = 1
    Task { await loadTour() }
  }

  func closeFullTour() { fullTourStep = nil }

  func stepFullTour(_ delta: Int) {
    guard let i = fullTourStep else { return }
    fullTourStep = max(1, min(max(1, steps.count), i + delta))
  }

  /// Show me: loads the step's view state.
  func showMe() {
    guard let step = currentStep else { return }
    experience?.load(hash: step.state)
  }
}

extension ViewState.StrandID {
  /// The id as the reference prints it ("12", "hip hop").
  nonisolated var text: String {
    switch self {
    case .number(let n): String(n)
    case .string(let s): s
    }
  }
}
