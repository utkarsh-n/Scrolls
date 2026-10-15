// OWNER: N5
// The provenance helpers the lineage modules call in the reference (server/provenance/relationships.mjs `resolveRef`,
// reviews.mjs `reviewStatusOf`, anchors.mjs `makeAnchor`). ScrollsLineage does not depend on ScrollsProvenance
// (IOS-SPEC §1.2: Lineage → Analysis), so the few lines it needs are ported here, statement for statement; N6's
// ScrollsProvenance keeps the full module.

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A resolved entity reference (`resolveRef`'s return value).
struct LineageRef: Sendable {
  struct Passage: Sendable {
    var id: Int64
    var documentId: Int64
    var field: String
    var startOff: Int
    var endOff: Int
  }
  var type: String
  var ref: String
  var docId: Int64?
  var passage: Passage?
  var synthetic: Int64 = 0
  var yLo: Int64?
  var yHi: Int64?
  var title: String?
  var dateLabel: String?
}

enum LineageRefs {
  /// The integer id `resolveRef` accepts: `Number(id)` a safe positive integer with `String(num) === String(id).trim()`.
  static func intId(_ id: String) -> Int64? {
    let n = JSNumber.parse(id)
    guard JSNumber.isSafeInteger(n), n > 0, JSString.equal(JSNumber.format(n), JSString.trim(id)) else { return nil }
    return Int64(n)
  }

  /// `resolveRef(db, type, id)`.
  static func resolve(_ c: Connection, type: String, id: String) throws -> LineageRef? {
    var base = LineageRef(type: type, ref: id)
    let n = intId(id)
    func docInfo(_ r: Row, _ doc: Int32, _ syn: Int32, _ ylo: Int32, _ yhi: Int32, _ title: Int32, _ label: Int32) {
      base.docId = r.int(doc)
      base.synthetic = r.int(syn)
      base.yLo = r.intOrNil(ylo)
      base.yHi = r.intOrNil(yhi)
      base.title = r.textOrNil(title)
      base.dateLabel = r.textOrNil(label)
    }
    func found(_ v: Bool?) -> LineageRef? { v == true ? base : nil }
    switch type {
    case "passage":
      guard let n else { return nil }
      return found(try c.prepared(LineageSQL.refPassage).bindingFirst([.int(n)]) { r -> Bool in
        docInfo(r, 1, 5, 6, 7, 8, 9)
        base.passage = .init(id: r.int(0), documentId: r.int(1), field: r.text(2), startOff: Int(r.int(3)), endOff: Int(r.int(4)))
        return true
      })
    case "document":
      guard let n else { return nil }
      return found(try c.prepared(LineageSQL.refDocument).bindingFirst([.int(n)]) { r -> Bool in
        docInfo(r, 0, 1, 2, 3, 4, 5)
        return true
      })
    case "occurrence":
      guard let n else { return nil }
      guard let pid = try c.prepared(LineageSQL.refOccurrence).bindingFirst([.int(n)], { r -> Int64 in
        docInfo(r, 1, 3, 4, 5, 6, 7)
        return r.int(2)
      }) else { return nil }
      base.passage = try c.prepared(LineageSQL.refPassageBounds).bindingFirst([.int(pid)]) {
        .init(id: $0.int(0), documentId: $0.int(1), field: $0.text(2), startOff: Int($0.int(3)), endOff: Int($0.int(4)))
      }
      return base
    case "expression":
      guard let n else { return nil }
      return found(try c.prepared(LineageSQL.refExpression).bindingFirst([.int(n)]) { r -> Bool in
        base.synthetic = r.int(1)
        base.title = r.textOrNil(2)
        return true
      })
    case "cluster":
      guard let n else { return nil }
      return found(try c.prepared(LineageSQL.refCluster).bindingFirst([.int(n)]) { r -> Bool in
        base.synthetic = r.int(2)
        base.title = r.textOrNil(1)
        return true
      })
    case "etymon":
      return found(try c.prepared(LineageSQL.refEtymon).bindingFirst([.text(id)]) { r -> Bool in
        base.title = r.textOrNil(1)
        return true
      })
    case "relationship":
      guard let n else { return nil }
      return found(try c.prepared(LineageSQL.refRelationship).bindingFirst([.int(n)]) { r -> Bool in
        base.synthetic = r.int(1)
        return true
      })
    case "hypothesis_group":
      guard let n else { return nil }
      return found(try c.prepared(LineageSQL.refHypothesisGroup).bindingFirst([.int(n)]) { r -> Bool in
        base.synthetic = r.int(1)
        base.title = r.textOrNil(2)
        return true
      })
    case "saved_view":
      return found(try c.prepared(LineageSQL.refSavedView).bindingFirst([.text(id)]) { r -> Bool in
        base.synthetic = r.intOrNil(2) ?? 0
        base.title = r.textOrNil(1)
        return true
      })
    case "time_window":
      guard let n else { return nil }
      return found(try c.prepared(LineageSQL.refTimeWindow).bindingFirst([.int(n)]) { r -> Bool in
        base.title = r.textOrNil(1)
        return true
      })
    case "annotation":
      guard let n else { return nil }
      return found(try c.prepared(LineageSQL.refAnnotation).bindingFirst([.int(n)]) { r -> Bool in
        base.synthetic = r.int(1)
        return true
      })
    default:
      return nil
    }
  }

  /// reviews.mjs `reviewStatusOf(revisions)`: each reviewer's latest decision; any dispute, or a confirm against a
  /// reject, is disputed.
  static func reviewStatus(_ revisions: [(actor: String, action: String)]) -> String {
    var latest: [String: String] = [:]
    var order: [String] = []
    for r in revisions {
      if r.action == "confirm" || r.action == "reject" || r.action == "dispute" {
        if latest[r.actor] == nil { order.append(r.actor) }
        latest[r.actor] = r.action
      } else if r.action == "retract" {
        latest[r.actor] = nil
      }
    }
    var confirms = 0, rejects = 0, disputes = 0
    for a in latest.values {
      if a == "confirm" { confirms += 1 } else if a == "reject" { rejects += 1 } else { disputes += 1 }
    }
    if disputes > 0 || (confirms > 0 && rejects > 0) { return "disputed" }
    if confirms > 0 { return "confirmed" }
    if rejects > 0 { return "rejected" }
    return "unreviewed"
  }

  /// anchors.mjs `ANCHOR_CONTEXT`.
  static let anchorContext = 32

  /// anchors.mjs `makeAnchor(original, {field, start, end}, {docId, sha})`: the quote with 32 code units of context, as
  /// `JSON.stringify` writes it (the reference's key order), ready for `anchor_json`.
  static func makeAnchor(_ original: [UInt16], field: String, start: Int, end: Int, docId: Int64?, sha: String?) throws -> String {
    guard start >= 0, end <= original.count, start < end else {
      throw ScrollsError(code: .internalError,
                         message: "makeAnchor: span \(start)–\(end) is empty or outside the text (length \(original.count))",
                         status: 500)
    }
    let digest = sha ?? TextDigest.sha256Hex(utf8: String(decoding: original, as: UTF16.self))
    func s(_ a: Int, _ b: Int) -> JSONValue { .string(String(decoding: original[a..<b], as: UTF16.self)) }
    return LineageJSON.ordered([
      ("doc_id", docId.map { .number(Double($0)) } ?? .null),
      ("sha256", .string(digest)),
      ("field", .string(field)),
      ("start", .number(Double(start))),
      ("end", .number(Double(end))),
      ("quote", s(start, end)),
      ("prefix", s(Swift.max(0, start - anchorContext), start)),
      ("suffix", s(end, Swift.min(original.count, end + anchorContext))),
    ])
  }
}

/// `JSON.stringify` of an object literal whose keys keep their written order (stored JSON columns are bytes the
/// reference wrote in that order); leaves are written by CanonicalJSON (JSNumber, JSON string escapes).
enum LineageJSON {
  static func ordered(_ members: [(String, JSONValue)]) -> String {
    "{" + members.map { CanonicalJSON.string(.string($0.0)) + ":" + CanonicalJSON.string($0.1) }.joined(separator: ",") + "}"
  }
}
