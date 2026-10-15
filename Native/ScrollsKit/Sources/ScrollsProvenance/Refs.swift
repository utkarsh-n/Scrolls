// OWNER: N6
// Port of the reference helpers every provenance route shares (server/provenance/relationships.mjs): who acts
// (`authorName`, `humanActor`, the machine-author guard of honesty rule 10), review notes (`checkNote`), and
// `resolveRef`: an entity reference → what links and annotations need (existence, document, dates, synthetic flag).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A resolved entity reference (`resolveRef`).
public struct RefTarget: Sendable, Equatable {
  public var type: String
  /// `String(id)` exactly as given.
  public var ref: String
  public var docId: Int64?
  public var passage: Anchors.PassageBounds?
  public var synthetic: Int
  public var yLo: Int?
  public var yHi: Int?
  public var title: String?
  public var dateLabel: String?
}

public enum Refs {
  /// Author prefixes that mark machine output (runs, adapters, taggers, models, jobs): a person cannot sign as one.
  static let machinePrefixes = ["machine", "run", "adapter", "algorithm", "model", "job", "system", "tagger", "analysis"]

  /// `authorName(raw)`: a person's display name from a request, default 'you'; a leading 'human:' is dropped.
  public static func authorName(_ raw: JSONValue?) throws -> String {
    guard let raw, !raw.isNull else { return "you" }
    if case .string(let s) = raw, s.isEmpty { return "you" }
    guard let s = raw.stringValue else { throw ProvenanceError.invalid("author must be a string.", field: "author") }
    let name = JSString.trim(JSString.hasPrefix(s, "human:") ? String(String.UnicodeScalarView(s.unicodeScalars.dropFirst(6))) : s)
    if name.isEmpty || name.utf16.count > 80 || name.utf16.contains(where: { $0 < 0x20 }) {
      throw ProvenanceError.invalid("author must be 1–80 printable characters.", field: "author")
    }
    if isMachineAuthor(name) {
      let head = JSString.split(name, ":").first ?? name
      throw ProvenanceError.invalid("Author names that start with '\(head):' are reserved for machine output.", field: "author")
    }
    return name
  }

  /// `MACHINE_AUTHOR = /^\s*(machine|run|…)\s*:/i`.
  static func isMachineAuthor(_ name: String) -> Bool {
    var u = Substring(name).utf16[...]
    while let f = u.first, JSString.isWhitespace(f) { u = u.dropFirst() }
    let rest = Array(u)
    for p in machinePrefixes {
      let pu = Array(p.utf16)
      guard rest.count >= pu.count else { continue }
      var ok = true
      for (i, ch) in pu.enumerated() {
        var x = rest[i]
        if x >= 0x41 && x <= 0x5A { x += 0x20 }
        if x != ch { ok = false; break }
      }
      guard ok else { continue }
      var j = pu.count
      while j < rest.count, JSString.isWhitespace(rest[j]) { j += 1 }
      if j < rest.count, rest[j] == 0x3A { return true }
    }
    return false
  }

  /// `'human:<name>'` for created_by / actor columns.
  public static func humanActor(_ name: String) -> String { "human:\(name)" }

  static let minNote = 10
  static let maxNote = 4000

  /// `checkNote(note, {field, required})`: a review or proposal note of at least 10 characters after trimming.
  public static func checkNote(_ note: JSONValue?, field: String = "note", required: Bool = true) throws -> String? {
    if note == nil || note!.isNull || note!.stringValue == "" {
      if !required { return nil }
      throw ProvenanceError.invalid("A note of at least \(minNote) characters is required.", field: field,
                                    hint: "Say what you checked.", extra: [("min", .number(Double(minNote)))])
    }
    guard let s = note!.stringValue else { throw ProvenanceError.invalid("\(field) must be a string.", field: field) }
    let t = JSString.trim(s)
    if t.utf16.count < minNote {
      throw ProvenanceError.invalid("A note needs at least \(minNote) characters.", field: field, hint: "Say what you checked.",
                                    extra: [("min", .number(Double(minNote)))])
    }
    if t.utf16.count > maxNote { throw ProvenanceError.invalid("A note may have at most \(maxNote) characters.", field: field) }
    return t
  }

  /// The integer id of a reference string as `resolveRef` accepts it: a safe positive integer whose `String(num)`
  /// equals the trimmed input.
  static func intId(_ id: String) -> Int64? {
    let n = JSNumber.parse(id)
    guard JSNumber.isSafeInteger(n), n > 0, JSNumber.format(n) == JSString.trim(id) else { return nil }
    return Int64(n)
  }

  /// `resolveRef(db, type, id)`.
  public static func resolve(_ c: Connection, type: String, id: String) throws -> RefTarget? {
    var base = RefTarget(type: type, ref: id, docId: nil, passage: nil, synthetic: 0, yLo: nil, yHi: nil, title: nil, dateLabel: nil)
    let n = intId(id)
    func docInfo(_ r: Row, doc: Int32, syn: Int32, ylo: Int32, yhi: Int32, title: Int32, label: Int32) {
      base.docId = r.int(doc)
      base.synthetic = Int(r.int(syn))
      base.yLo = r.intOrNil(ylo).map(Int.init)
      base.yHi = r.intOrNil(yhi).map(Int.init)
      base.title = r.textOrNil(title)
      base.dateLabel = r.textOrNil(label)
    }
    switch type {
    case "passage":
      guard let n else { return nil }
      let found = try c.prepared(ProvenanceSQL.refPassage).bindingFirst([.int(n)]) { r -> Bool in
        docInfo(r, doc: 1, syn: 5, ylo: 6, yhi: 7, title: 8, label: 9)
        base.passage = .init(id: r.int(0), documentId: r.int(1), field: r.text(2), startOff: Int(r.int(3)), endOff: Int(r.int(4)))
        return true
      }
      return found == true ? base : nil
    case "document":
      guard let n else { return nil }
      let found = try c.prepared(ProvenanceSQL.refDocument).bindingFirst([.int(n)]) { r -> Bool in
        docInfo(r, doc: 0, syn: 1, ylo: 2, yhi: 3, title: 4, label: 5)
        return true
      }
      return found == true ? base : nil
    case "occurrence":
      guard let n else { return nil }
      guard let pid = try c.prepared(ProvenanceSQL.refOccurrence).bindingFirst([.int(n)], { r -> Int64 in
        docInfo(r, doc: 1, syn: 3, ylo: 4, yhi: 5, title: 6, label: 7)
        return r.int(2)
      }) else { return nil }
      base.passage = try c.prepared(ProvenanceSQL.passageBounds).bindingFirst([.int(pid)]) {
        .init(id: $0.int(0), documentId: $0.int(1), field: $0.text(2), startOff: Int($0.int(3)), endOff: Int($0.int(4)))
      }
      return base
    case "expression":
      guard let n else { return nil }
      let found = try c.prepared(ProvenanceSQL.refExpression).bindingFirst([.int(n)]) { r -> Bool in
        base.synthetic = Int(r.int(1))
        base.title = r.text(2)
        return true
      }
      return found == true ? base : nil
    case "cluster":
      guard let n else { return nil }
      let found = try c.prepared(ProvenanceSQL.refCluster).bindingFirst([.int(n)]) { r -> Bool in
        base.synthetic = Int(r.int(2))
        base.title = r.textOrNil(1)
        return true
      }
      return found == true ? base : nil
    case "etymon":
      let found = try c.prepared(ProvenanceSQL.refEtymon).bindingFirst([.text(id)]) { r -> Bool in
        base.title = r.textOrNil(1)
        return true
      }
      return found == true ? base : nil
    case "relationship":
      guard let n else { return nil }
      let found = try c.prepared(ProvenanceSQL.refRelationship).bindingFirst([.int(n)]) { r -> Bool in
        base.synthetic = Int(r.int(1))
        return true
      }
      return found == true ? base : nil
    case "hypothesis_group":
      guard let n else { return nil }
      let found = try c.prepared(ProvenanceSQL.refHypothesisGroup).bindingFirst([.int(n)]) { r -> Bool in
        base.synthetic = Int(r.int(1))
        base.title = r.text(2)
        return true
      }
      return found == true ? base : nil
    case "saved_view":
      let found = try c.prepared(ProvenanceSQL.refSavedView).bindingFirst([.text(id)]) { r -> Bool in
        base.synthetic = Int(r.intOrNil(2) ?? 0)
        base.title = r.text(1)
        return true
      }
      return found == true ? base : nil
    case "time_window":
      guard let n else { return nil }
      let found = try c.prepared(ProvenanceSQL.refTimeWindow).bindingFirst([.int(n)]) { r -> Bool in
        base.title = r.textOrNil(1)
        return true
      }
      return found == true ? base : nil
    case "annotation":
      guard let n else { return nil }
      let found = try c.prepared(ProvenanceSQL.refAnnotation).bindingFirst([.int(n)]) { r -> Bool in
        base.synthetic = Int(r.int(1))
        return true
      }
      return found == true ? base : nil
    default:
      return nil
    }
  }

  /// `resolveRefString(db, 'passage:901')`: parse a reference (`etymon:sa:शून्य` keeps its inner colon) and resolve it.
  public static func resolve(_ c: Connection, string s: String) throws -> RefTarget? {
    guard let r = try? IDs.parseRef(s) else { return nil }
    let id: String = switch r.id {
    case .number(let n): String(n)
    case .string(let t): t
    }
    return try resolve(c, type: r.type, id: id)
  }

  /// The reference's `String(x)` of a JSON value used as a ref (a number prints as JavaScript prints it).
  public static func refString(_ v: JSONValue) -> String { Anchors.jsString(v) }
}
