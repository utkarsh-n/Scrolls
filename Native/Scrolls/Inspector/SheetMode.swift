// OWNER: N8
// What the inspector shows (IOS-SPEC §4.8): a small state machine, `SheetMode` — idle · search · inspector(selection) ·
// drawer(bin) · shelf(list) · yourTurn — and the plain-value references it carries. Every case is Codable, so the mode
// survives a kill in `@SceneStorage("ui")` (§4.15) and never holds an engine object.

import ScrollsCore

/// A selected item the Then column opens: an occurrence, a passage, a document or a relationship (`vocab.SELECTION_TYPES`
/// minus `cluster` and `bin`, which have their own views).
nonisolated struct InspectedRef: Hashable, Codable, Sendable {
  /// "occurrence" · "passage" · "document" · "relationship"
  var type: String
  var id: Int

  /// The kinds the Then column opens on (`inspector.mjs` INSPECTABLE, plus relationships, whose edge card N5 draws).
  static let types: Set<String> = ["occurrence", "passage", "document", "relationship"]

  /// The ref of a view-state selection, if the Then column opens on it.
  init?(_ selection: ViewState.Selection?) {
    guard let selection, Self.types.contains(selection.type), case .number(let n) = selection.id else { return nil }
    type = selection.type
    id = n
  }

  init(type: String, id: Int) {
    self.type = type
    self.id = id
  }

  /// The view-state selection that names this ref.
  var selection: ViewState.Selection { ViewState.Selection(type: type, id: .number(id)) }
}

/// A bin of the Scroll (`viewport.mjs` binId): `lane~strand~tier~bin`, the id of a `bin` selection.
nonisolated struct BinRef: Hashable, Codable, Sendable {
  var lane: String
  var strand: String
  /// "L0" … "L5"
  var tier: String
  var bin: Int

  /// `parseBinId`: four `~`-separated parts, a tier L0–L5 and an integer bin; anything else is nil.
  init?(selectionID: String) {
    let parts = selectionID.split(separator: "~", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 4, let bin = Int(parts[3]), parts[2].count == 2, parts[2].hasPrefix("L"),
          let level = Int(parts[2].dropFirst()), (0...5).contains(level) else { return nil }
    lane = parts[0]
    strand = parts[1]
    tier = parts[2]
    self.bin = bin
  }

  init(lane: String, strand: String, tier: String, bin: Int) {
    self.lane = lane
    self.strand = strand
    self.tier = tier
    self.bin = bin
  }

  /// `binId(ref)`.
  var selectionID: String { "\(lane)~\(strand)~\(tier)~\(bin)" }

  /// The view-state selection of this bin.
  var selection: ViewState.Selection { ViewState.Selection(type: "bin", id: .string(selectionID)) }
}

/// A shelf list (`drawer.mjs` spec kind 'shelf'): UNDATED, SCHEDULED or the washes of a lane.
nonisolated struct ShelfRef: Hashable, Codable, Sendable {
  /// "undated" · "scheduled" · "washes"
  var which: String
  var lane: String?
  var strand: String?
  /// The list's title ("Undated · Hip-hop", "Records dated c. 1960").
  var title: String
}

/// The inspector's content state (§4.8).
nonisolated enum SheetMode: Hashable, Codable, Sendable {
  /// Nothing selected: the peek row (search and transport) and, taller, the start card.
  case idle
  /// The search field has focus: typed suggestions and results.
  case search
  /// A selected mark, passage, document or relationship: Then / Now / Next.
  case inspector(InspectedRef)
  /// A tapped aggregate bin: the denominator line and its KWIC rows.
  case drawer(BinRef)
  /// A shelf chip (⊘ undated, ⇥ scheduled) or a wash: a searchable list.
  case shelf(ShelfRef)
  /// The end of the first minute (§4.17): Your turn.
  case yourTurn

  /// A short name for logs, tests and VoiceOver.
  var name: String {
    switch self {
    case .idle: "idle"
    case .search: "search"
    case .inspector(let r): "inspector \(r.type) \(r.id)"
    case .drawer(let b): "drawer \(b.selectionID)"
    case .shelf(let s): "shelf \(s.which)"
    case .yourTurn: "yourTurn"
    }
  }
}

/// The inspector's tabs; Now and Next arrive at M3 (§8.5 N8), and until then say what they will hold.
nonisolated enum InspectorTab: String, Hashable, Codable, Sendable, CaseIterable {
  case then, now, next
}
