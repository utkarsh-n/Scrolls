// OWNER: N8
// The Then column's data (IOS-SPEC §4.8; port of `panels/inspector.mjs` loadTarget, loadUses and loadSelectedSpan):
// the selected passage with its document and date card, its neighbours on request, the occurrence's span, and the
// contemporary uses of the expression in the window W = max(10 y, 2 × date width) with their denominator. An
// occurrence resolves to its passage through the engine (`occurrence(id)`), never by guessing; a load that is
// superseded by a newer selection is dropped.

import Observation
import ScrollsContracts
import ScrollsCore
import ScrollsService

/// A load's state: nothing asked, counting/opening, done, or an error card.
nonisolated enum LoadState<Value: Sendable & Equatable>: Sendable, Equatable {
  case idle
  case loading
  case loaded(Value)
  case failed(ErrorCardModel)

  var value: Value? { if case .loaded(let v) = self { v } else { nil } }
  var isLoading: Bool { if case .loading = self { true } else { false } }
}

/// The contemporary uses (§4.8): at most 3 rows per lane and 9 in all, under their denominator line.
nonisolated struct ContemporaryUses: Sendable, Equatable {
  /// The window, in years.
  var from: Int
  var to: Int
  var rows: [KwicRow]
  var total: Int?
  var tokens: Int?
}

/// Why the uses list is not shown: the passage carries no year interval, or no tracked expression is highlighted.
nonisolated enum UsesAbsence: Sendable, Equatable {
  case noDate(String)
  case noExpression
}

nonisolated enum ThenRules {
  /// Contemporary uses: at most 3 per lane and 9 in all (§2.D).
  static let usesPerLane = 3
  static let usesMax = 9

  /// `cardYears`: the year interval of a date card, read by the shared date grammar (a trailing "(VS 1987)" ignored).
  static func cardYears(_ label: String?) -> (lo: Int, hi: Int)? {
    guard let label, !label.isEmpty else { return nil }
    var candidates = [label]
    if let r = label.range(of: #"\s*\([^)]*\)\s*$"#, options: .regularExpression) {
      candidates.append(String(label[..<r.lowerBound]))
    }
    for raw in candidates {
      let p = DateGrammar.parse(raw, context: DateContext())
      if p.issue == nil, let lo = p.yLo, let hi = p.yHi { return (Int(lo), Int(hi)) }
    }
    return nil
  }

  /// `contemporaryWindow`: W = max(10, 2 × width) years centred on the date.
  static func contemporaryWindow(_ years: (lo: Int, hi: Int)?) -> (from: Int, to: Int)? {
    guard let years else { return nil }
    let width = years.hi - years.lo + 1
    let w = Double(max(10, 2 * width))
    let mid = Double(years.lo + years.hi) / 2
    return (Int((mid - w / 2).rounded(.down)), Int((mid + w / 2).rounded(.up)))
  }

  /// `stratifyUses`: drop the passage itself; keep at most `perLane` rows per lane and `max` in all, in the engine's order.
  static func stratify(_ rows: [KwicRow], exclude: PassageID?, perLane: Int = usesPerLane, max: Int = usesMax) -> [KwicRow] {
    var per: [String: Int] = [:]
    var out: [KwicRow] = []
    for r in rows {
      if out.count >= max { break }
      if let exclude, r.passage == exclude { continue }
      let lane = r.lane ?? ""
      let k = per[lane, default: 0]
      if k >= perLane { continue }
      per[lane] = k + 1
      out.append(r)
    }
    return out
  }

  /// `usesDenominator`: "n = 37 in 1925–1945 · 6.1M tokens".
  static func usesDenominator(total: Int?, tokens: Int?, from: Int, to: Int) -> String {
    let n = total.map(Format.int) ?? Format.dash
    let t = tokens.map { " · \(Format.tokens($0)) tokens" } ?? ""
    return "n = \(n) in \(from)–\(to)\(t)"
  }

  /// The expression of the first highlight that names one (the one the inspector is about).
  static func expression(of p: PassageResponse) -> ExpressionID? {
    p.highlights.lazy.compactMap(\.expr).first
  }
}

@MainActor @Observable
final class ThenModel {
  @ObservationIgnored private unowned let app: AppModel
  /// What is open.
  private(set) var target: InspectedRef?
  private(set) var passage: LoadState<PassageResponse> = .idle
  private(set) var document: LoadState<DocumentResponse> = .idle
  /// The selected occurrence (marked in the passage), when an occurrence was selected.
  private(set) var selectedOcc: OccurrenceID?
  /// The selected occurrence's span relative to the passage text, when its id is not among the highlights.
  private(set) var selectedSpan: Range<Int>?
  /// The neighbouring passages are shown (±1 passage).
  private(set) var withContext = false
  private(set) var uses: LoadState<ContemporaryUses> = .idle
  private(set) var usesAbsence: UsesAbsence?
  /// Increases with every new load; answers to an older one are dropped.
  @ObservationIgnored private var seq = 0
  @ObservationIgnored private var task: Task<Void, Never>?

  init(app: AppModel) {
    self.app = app
  }

  /// Opens a selection (or clears with nil).
  func open(_ ref: InspectedRef?) {
    guard ref != target || ref == nil else { return }
    target = ref
    withContext = false
    reload()
  }

  /// ±1 passage on or off (reloads the passage with or without its neighbours).
  func toggleContext() {
    withContext.toggle()
    reload()
  }

  func retry() { reload() }

  /// Reloads only the contemporary uses (their Retry).
  func retryUses() {
    guard let p = passage.value else { return }
    let mySeq = seq
    task = Task { await loadUses(p, seq: mySeq) }
  }

  private func reload() {
    seq += 1
    let mySeq = seq
    task?.cancel()
    passage = .idle
    document = .idle
    uses = .idle
    usesAbsence = nil
    selectedSpan = nil
    selectedOcc = nil
    guard let target, let atlas = app.atlas else { return }
    switch target.type {
    case "occurrence", "passage":
      passage = .loading
      task = Task { await loadPassage(target, atlas: atlas, seq: mySeq) }
    case "document":
      document = .loading
      task = Task { await loadDocument(DocumentID(target.id), atlas: atlas, seq: mySeq) }
    default:
      break
    }
  }

  private func loadPassage(_ target: InspectedRef, atlas: any AtlasService, seq mySeq: Int) async {
    do {
      var passageID = PassageID(target.id)
      var occ: OccurrenceResponse?
      if target.type == "occurrence" {
        // No guessing: the engine says which passage holds the occurrence.
        let o = try await atlas.occurrence(OccurrenceID(target.id))
        guard mySeq == seq else { return }
        passageID = o.passage
        occ = o
        selectedOcc = o.id
      }
      let p = try await atlas.passage(passageID, PassageRequest(context: withContext ? true : nil, occ: occ?.id))
      guard mySeq == seq else { return }
      passage = .loaded(p)
      // The selected occurrence comes from the query's pinned run; when its id is not among the newest run's
      // highlights, its offsets mark the highlight covering the same characters (`loadSelectedSpan`).
      if let o = occ, !p.highlights.contains(where: { $0.occ == o.id }), o.passage == p.id {
        selectedSpan = (o.start - p.start)..<(o.end - p.start)
      }
      await loadUses(p, seq: mySeq)
    } catch {
      guard mySeq == seq, !(error is CancellationError) else { return }
      passage = .failed(ErrorCardModel(any: error, what: ThenCopy.openFailed))
    }
  }

  private func loadDocument(_ id: DocumentID, atlas: any AtlasService, seq mySeq: Int) async {
    do {
      let d = try await atlas.document(id)
      guard mySeq == seq else { return }
      document = .loaded(d)
    } catch {
      guard mySeq == seq, !(error is CancellationError) else { return }
      document = .failed(ErrorCardModel(any: error, what: ThenCopy.openFailed))
    }
  }

  /// Contemporary uses in W around the passage's date, sorted to spread across documents, stratified by lane.
  private func loadUses(_ p: PassageResponse, seq mySeq: Int) async {
    guard let expr = ThenRules.expression(of: p) else {
      usesAbsence = .noExpression
      uses = .idle
      return
    }
    guard let w = ThenRules.contemporaryWindow(ThenRules.cardYears(p.document.dateCard.label)) else {
      usesAbsence = .noDate(p.document.dateCard.label.isEmpty ? ThenCopy.undated : p.document.dateCard.label)
      uses = .idle
      return
    }
    guard let atlas = app.atlas else { return }
    uses = .loading
    do {
      let kwic = try await atlas.kwic(KwicRequest(expr: expr, f: ViewQuery.filter(app.viewState), from: w.from, to: w.to,
                                                  sort: "spread", limit: 60))
      guard mySeq == seq else { return }
      uses = .loaded(ContemporaryUses(from: w.from, to: w.to, rows: ThenRules.stratify(kwic.rows, exclude: p.id),
                                      total: kwic.total, tokens: kwic.denominator?.tokens))
    } catch {
      guard mySeq == seq, !(error is CancellationError) else { return }
      uses = .failed(ErrorCardModel(any: error))
    }
  }
}
