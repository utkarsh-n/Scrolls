// OWNER: N3
// Port of server/aggregate/lanes.mjs (SPEC §1.3, §1.2 item 8): lane facets, keys, labels and order rules. A lane is a
// facet value × unit class; units never mix, so text (tokens) and titles (works) evidence of one facet value become
// sub-lanes. Keys are data-independent: `community:classroom` for text evidence, `community:classroom~titles` /
// `~abstracts` for the others. Lane order is a sorting choice, never derived from an embedding or projection.
// The SQL twins of these functions are in SliceSQL.swift.

import Foundation
import ScrollsCore

/// The pieces of a lane key.
public struct LaneKeyParts: Sendable, Equatable {
  public var facet: String
  public var value: String?
  public var unitClass: String
}

/// Lane keys, labels and order.
public enum Lanes {
  /// Placeholder value of a lane whose facet value is missing.
  public static let none = "(none)"
  static let unitSuffixes: Set<String> = ["titles", "abstracts"]

  /// `laneKey(facet, value, unitClass)`.
  public static func key(_ facet: String, _ value: String?, _ unitClass: String) -> String {
    let v = (value == nil || value == "") ? none : value!
    return facet == "modality" || facet == "trail" || unitClass == "text" ? "\(facet):\(v)" : "\(facet):\(v)~\(unitClass)"
  }

  /// A lane's error: not a lane key, an unknown facet, or not a Term trail lane.
  public struct KeyError: Error, Sendable { public let message: String }

  /// `parseLaneKey(key)`.
  public static func parse(_ key: String) throws(KeyError) -> LaneKeyParts {
    let s = key
    let i = JSString.indexOf(s, ":")
    if i <= 0 { throw KeyError(message: "not a lane key: '\(s)'") }
    let facet = JSText.slice(s, 0, i)
    if !Vocab.laneFacets.contains(facet) { throw KeyError(message: "unknown lane facet in '\(s)'") }
    var value = JSText.slice(s, i + 1)
    var unitClass = "text"
    let u = Array(value.utf16)
    if let t = u.lastIndex(of: 0x7E), t > 0 {
      let suffix = JSText.string(u[(t + 1)...])
      if unitSuffixes.contains(suffix) {
        unitClass = suffix
        value = JSText.string(u[..<t])
      }
    }
    if facet == "modality" { unitClass = value }
    if facet == "trail" {
      guard TrailLanes.lane(value) != nil else { throw KeyError(message: "not a Term trail lane: '\(s)'") }
      unitClass = TrailLanes.unitClass(value)
    }
    return LaneKeyParts(facet: facet, value: value == none ? nil : value, unitClass: unitClass)
  }

  /// `unitClassOf(fieldClass)` of a row: title → titles, abstract → abstracts, otherwise text.
  public static func unitClass(ofFieldClass fc: String) -> String {
    fc == "title" ? "titles" : fc == "abstract" ? "abstracts" : "text"
  }

  static let languageNames: [String: String] = [
    "en": "English", "fr": "French", "es": "Spanish", "de": "German", "la": "Latin", "it": "Italian", "pt": "Portuguese",
    "hi": "Hindi", "gu": "Gujarati", "sa": "Sanskrit", "mr": "Marathi", "und": "Unidentified language",
    "und-Latn": "Unidentified (Latin script, too short to identify)",
  ]
  static let modalityLabels: [String: String] = ["text": "Text (full text)", "titles": "Titles", "abstracts": "Abstracts"]
  static let noneLabels: [String: String] = ["community": "(no community)", "culture": "(no country of origin)",
                                             "field": "(no field)", "kind": "(no kind)"]
  static let domainLabels: [String: String] = ["stemm": "STEMM"]
  /// data/demo/generator.mjs COMMUNITIES.
  static let communities: [String: String] = [
    "classroom": "Classroom", "office-lab": "Office & Lab", "hiphop": "Hip-hop", "criticism": "Criticism",
    "software": "Software", "gujarati": "Gujarati verse & school", "hindi": "Hindi verse", "hospital": "Hospital",
    "literature": "Literature", "workshop-radio": "Workshop & Radio",
  ]

  /// `humanize(s)`: separators to spaces, trimmed, first code unit upper-cased.
  static func humanize(_ s: String) -> String {
    var u: [UInt16] = []
    var inSep = false
    for c in s.utf16 {
      if c == 0x2D || c == 0x5F {
        if !inSep { u.append(0x20) }
        inSep = true
      } else {
        u.append(c)
        inSep = false
      }
    }
    let t = JSString.trim(JSText.string(u))
    guard !t.isEmpty else { return t }
    let tu = Array(t.utf16)
    return JSString.toUpperCase(JSText.string([tu[0]])) + JSText.string(tu[1...])
  }

  /// `laneLabel(facet, value, unitClass, {collectionNames})`.
  public static func label(_ facet: String, _ value: String?, _ unitClass: String, collectionNames: [String: String] = [:]) -> String {
    if facet == "trail" { return TrailLanes.lane(value ?? "")?.label ?? (value ?? "null") }
    let base: String
    if let value {
      switch facet {
      case "cluster": base = JSString.hasSuffix(value, ":residual") ? "Other contexts" : "Context group \(JSString.split(value, ":")[safe: 1] ?? "undefined")"
      case "language": base = languageNames[value] ?? value
      case "modality": base = modalityLabels[value] ?? value
      case "collection": base = collectionNames[value] ?? value
      case "culture": base = value
      case "community": base = communities[value] ?? humanize(value)
      case "domain": base = domainLabels[value] ?? humanize(value)
      case "field": base = Vocab.stemmLanes.first { $0.key == value }?.label ?? humanize(value)
      default: base = humanize(value)
      }
    } else {
      base = noneLabels[facet] ?? "(none)"
    }
    return facet == "modality" || unitClass == "text" ? base : "\(base) · \(unitClass)"
  }

  /// A lane as `orderLanes` sorts it.
  public struct Orderable {
    public var key: String
    public var label: String
    public var n: Int
    public var firstDay: Int?
  }

  /// `orderLanes(lanes, rule, manual)` (a stable sort; ties broken by label then key).
  public static func order<T>(_ lanes: [T], rule: String, manual: [String] = [], _ view: (T) -> Orderable) -> [T] {
    func alpha(_ a: Orderable, _ b: Orderable) -> Int {
      let c = JSText.localeCompare(a.label, b.label)
      return c != 0 ? c : JSText.localeCompare(a.key, b.key)
    }
    let pos = Dictionary(manual.enumerated().map { (JSKey($0.element), $0.offset) }, uniquingKeysWith: { _, b in b })
    let cmp: (Orderable, Orderable) -> Int
    switch rule {
    case "total_n": cmp = { a, b in a.n != b.n ? (b.n - a.n) : alpha(a, b) }
    case "alphabetical": cmp = alpha
    case "manual":
      cmp = { a, b in
        let pa = pos[JSKey(a.key)].map(Double.init) ?? .infinity, pb = pos[JSKey(b.key)].map(Double.init) ?? .infinity
        if pa != pb { return pa < pb ? -1 : 1 }
        return alpha(a, b)
      }
    default:
      cmp = { a, b in
        switch (a.firstDay, b.firstDay) {
        case (nil, nil): return alpha(a, b)
        case (nil, _): return 1
        case (_, nil): return -1
        case (let x?, let y?): return x != y ? (x < y ? -1 : 1) : alpha(a, b)
        }
      }
    }
    return stableSorted(lanes) { cmp(view($0), view($1)) < 0 }
  }

  /// `orderNote(rule)`: the legend sentence printed with every lane order.
  public static func orderNote(_ rule: String) -> String {
    let names = ["first_observed": "first observed", "total_n": "total n", "alphabetical": "alphabetical", "manual": "manual"]
    return replaceFirst(Copy.laneOrderNote, "(first observed)", "(\(names[rule] ?? rule))")
  }

  /// `selectionNote(samplings)`: every non-complete sampling among the lane's collections.
  public static func selectionNote(_ samplings: [String]) -> String? {
    var notes: [String] = []
    for s in samplings where !s.isEmpty && s != "complete" && s != "user" {
      let label = Copy.samplingLabels[s] ?? s
      if !notes.contains(label) { notes.append(label) }
    }
    return notes.isEmpty ? nil : notes.joined(separator: "; ")
  }

  static func replaceFirst(_ s: String, _ what: String, _ with: String) -> String {
    let i = JSString.indexOf(s, what)
    guard i >= 0 else { return s }
    return JSText.slice(s, 0, i) + with + JSText.slice(s, i + what.utf16.count)
  }
}

/// A stable sort (Array.prototype.sort is stable; Swift's `sorted` is not guaranteed to be).
public func stableSorted<T>(_ xs: [T], by less: (T, T) -> Bool) -> [T] {
  xs.enumerated().sorted { a, b in
    if less(a.element, b.element) { return true }
    if less(b.element, a.element) { return false }
    return a.offset < b.offset
  }.map(\.element)
}

extension Array {
  /// The element at `i`, or nil.
  public subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

extension JSString {
  /// `s.toUpperCase()` (NSString's full mapping; only first characters of lane labels are raised).
  public static func toUpperCase(_ s: String) -> String {
    if s.utf8.allSatisfy({ $0 < 0x80 }) {
      return String(decoding: s.utf8.map { $0 >= 0x61 && $0 <= 0x7A ? $0 - 0x20 : $0 }, as: UTF8.self)
    }
    return (s as NSString).uppercased
  }
}
