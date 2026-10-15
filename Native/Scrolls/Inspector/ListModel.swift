// OWNER: N8
// The bin drawer and the shelf lists (IOS-SPEC §4.8; port of `timeline/drawer.mjs`): the denominator line first, then
// KWIC rows by date, 50 a page; every row opens its passage, so every quantity on the Scroll is two taps from text.
// Shelves (UNDATED, SCHEDULED, washes) use the same list with a filter box. Both ask about the query on screen: the
// key the Scroll published on the bridge, or the same canonical request registered here.

import Observation
import ScrollsContracts
import ScrollsCore
import ScrollsService

/// One row of a shelf list (`Shelf.items`, verbatim JSON on the wire).
nonisolated struct ShelfItem: Sendable, Equatable, Identifiable {
  let id: String
  let title: String
  let author: String?
  let kind: String?
  let lane: String?
  let dateLabel: String?
  let n: Int?
  let passage: PassageID?
  let document: DocumentID?
  let synthetic: Bool

  init(_ v: JSONValue, index: Int) {
    let o = v.objectValue ?? [:]
    title = o["title"]?.stringValue ?? o["label"]?.stringValue ?? ""
    author = o["author"]?.stringValue
    kind = o["kind"]?.stringValue
    lane = o["lane"]?.stringValue
    if let d = o["date"]?.objectValue {
      dateLabel = d["label"]?.stringValue
    } else if let lo = o["lo"]?.stringValue, let hi = o["hi"]?.stringValue {
      dateLabel = lo == hi ? lo : "\(lo)–\(hi)"
    } else {
      dateLabel = nil
    }
    n = o["n"]?.numberValue.map { Int($0) }
    passage = o["passage"]?.numberValue.map { PassageID(Int($0)) }
    document = o["document_id"]?.numberValue.map { DocumentID(Int($0)) }
    synthetic = o["synthetic"]?.boolValue ?? false
    id = "\(index)-\(passage?.rawValue ?? -1)-\(document?.rawValue ?? -1)"
  }
}

nonisolated enum ListRules {
  static let pageSize = 50

  /// `denominatorLine`: the engine's `text` when it sends one, else built from its numbers.
  static func denominatorLine(_ d: JSONValue?) -> String {
    guard let o = d?.objectValue else { return "" }
    if let text = o["text"]?.stringValue { return text }
    var parts: [String] = []
    let n = o["n"]?.numberValue.map { Format.int(Int($0)) } ?? Format.dash
    parts.append("n = \(n) in \(o["label"]?.stringValue ?? "")")
    parts.append("\(Format.tokens(o["tokens"]?.numberValue)) tokens")
    if let docs = o["docs"]?.numberValue { parts.append("\(Format.int(Int(docs))) documents") }
    if let rate = o["rate"]?.numberValue, rate.isFinite, let unit = o["unit"]?.stringValue {
      let ci = o["ci"]?.arrayValue?.map(\.numberValue)
      parts.append("\(Format.rate(rate, unit: unit)) \(Format.ci(ci, unit: unit))")
    }
    return parts.joined(separator: " · ")
  }

  /// The line on top of a shelf (`drawer.mjs` renderMeta).
  static func shelfLine(_ which: String) -> String {
    switch which {
    case "undated": ThenCopy.undatedShelf
    case "scheduled": ThenCopy.scheduledShelf
    case "washes": ThenCopy.washesShelf
    default: ""
    }
  }

  /// `filterRows`: case-insensitive over title, author, match and date label.
  static func filter<T>(_ rows: [T], _ q: String, fields: (T) -> [String?]) -> [T] {
    let s = q.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty else { return rows }
    return rows.filter { r in fields(r).contains { $0?.localizedStandardContains(s) == true } }
  }

  /// "22 of 22", "50 of 1,894".
  static func countLine(shown: Int, total: Int) -> String { "\(Format.int(shown)) of \(Format.int(total))" }
}

@MainActor @Observable
final class ListModel {
  @ObservationIgnored private unowned let app: AppModel
  @ObservationIgnored private let bridge: ScrollBridge
  private(set) var bin: BinRef?
  private(set) var shelf: ShelfRef?
  /// The bin's denominator object (verbatim) and its line.
  private(set) var denominator: JSONValue?
  private(set) var kwicRows: [KwicRow] = []
  private(set) var shelfItems: [ShelfItem] = []
  private(set) var total = 0
  private(set) var cursor: String?
  private(set) var state: LoadState<Bool> = .idle
  /// The shelf's filter box.
  var filter = ""
  @ObservationIgnored private var seq = 0

  init(app: AppModel, bridge: ScrollBridge) {
    self.app = app
    self.bridge = bridge
  }

  var denominatorLine: String { ListRules.denominatorLine(denominator) }

  /// The denominator says the bin is synthetic material (the reference marks it in its text).
  var denominatorSynthetic: Bool { denominatorLine.contains("SYNTHETIC") }

  func openBin(_ ref: BinRef) {
    guard ref != bin else { return }
    bin = ref
    shelf = nil
    restart()
  }

  func openShelf(_ ref: ShelfRef) {
    guard ref != shelf else { return }
    shelf = ref
    bin = nil
    filter = ""
    restart()
  }

  func close() {
    bin = nil
    shelf = nil
    seq += 1
    kwicRows = []
    shelfItems = []
    denominator = nil
    state = .idle
  }

  func retry() { restart() }

  func loadMore() {
    guard cursor != nil, !state.isLoading else { return }
    Task { await load(next: true, seq: seq) }
  }

  private func restart() {
    seq += 1
    kwicRows = []
    shelfItems = []
    denominator = nil
    total = 0
    cursor = nil
    let mySeq = seq
    Task { await load(next: false, seq: mySeq) }
  }

  /// The registered key of the query on screen: the Scroll's, or the same canonical request registered here.
  private func queryKey(_ atlas: any AtlasService) async throws -> String {
    if let key = bridge.queryKey { return key }
    return try await atlas.timelineQuery(ViewQuery.request(app.viewState)).queryKey
  }

  private func load(next: Bool, seq mySeq: Int) async {
    guard let atlas = app.atlas else { return }
    state = .loading
    do {
      let q = try await queryKey(atlas)
      if let bin {
        let r = try await atlas.bin(BinRequest(q: q, lane: bin.lane, strand: bin.strand, tier: bin.tier, bin: bin.bin,
                                               cursor: next ? cursor : nil, limit: ListRules.pageSize))
        guard mySeq == seq else { return }
        denominator = r.denominator
        kwicRows = next ? kwicRows + r.rows : r.rows
        cursor = r.cursor
        total = r.total ?? kwicRows.count
      } else if let shelf {
        let r = try await atlas.shelf(ShelfRequest(q: q, which: shelf.which, lane: shelf.lane, cursor: next ? cursor : nil,
                                                   limit: ListRules.pageSize))
        guard mySeq == seq else { return }
        let items = (r.items.arrayValue ?? []).enumerated().map { ShelfItem($1, index: $0 + (next ? shelfItems.count : 0)) }
        shelfItems = next ? shelfItems + items : items
        cursor = r.cursor
        total = r.total
      }
      state = .loaded(true)
    } catch {
      guard mySeq == seq, !(error is CancellationError) else { return }
      state = .failed(ErrorCardModel(any: error))
    }
  }
}
