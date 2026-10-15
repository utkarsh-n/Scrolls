// OWNER: N4
// Passage text, KWIC rows, lanes and the representative passages of a slice (slices.mjs `passageTextReader`,
// `kwicAround`, `laneOf`, `samplePassages`; SPEC §2.E item 3): at most one passage per document, documents drawn in a
// seeded order (the bit-exact mulberry32), one of each document's counted matches drawn; the seed is printed so the
// draw can be reproduced. Text is read through `TextStore` (D4 UTF-16 offsets): the reference database's inline text
// on a clone, the device atlas's chunks on the phone.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Reads passage text by document, field and offsets (`passageTextReader`).
struct PassageTextReader {
  let connection: Connection
  let text: any TextStore
  private var fields: [String: String?] = [:]
  /// The reference layout keeps each original whole in one row: like the reference's reader, whole bodies are cached
  /// (a few documents; passages are read in id order, so one document's passages come together). The device's chunked
  /// store decodes only the chunks a range needs and is read directly.
  private var bodies: [Int: [UInt16]?] = [:]
  private var bodyOrder: [Int] = []
  private let inline: Bool
  static let cachedBodies = 16

  init(_ c: Connection, _ text: any TextStore) {
    connection = c
    self.text = text
    inline = text is InlineTextStore
  }

  /// The text of [start, end) of a document's body or field; nil when there is none.
  mutating func read(document: Int, field: String, start: Int, end: Int) -> String? {
    if field == "body" {
      guard inline else {
        return try? text.slice(DocumentID(rawValue: Int64(document)), Int32(start)..<Int32(end), on: connection)
      }
      if bodies[document] == nil {
        if bodyOrder.count >= Self.cachedBodies { bodies[bodyOrder.removeFirst()] = nil }
        let full = (try? text.fullText(DocumentID(rawValue: Int64(document)), on: connection)).map { Array($0.utf16) }
        bodies[document] = .some(full)
        bodyOrder.append(document)
      }
      guard let units = bodies[document] ?? nil else { return nil }
      // String.prototype.slice clamps to the text
      let a = min(max(0, start), units.count), b = min(max(a, end), units.count)
      return String(decoding: units[a..<b], as: UTF16.self)
    }
    let key = "\(document)|\(field)"
    let value: String?
    if let cached = fields[key] {
      value = cached
    } else {
      value = (try? connection.first(AnalysisSQL.field, [.int(Int64(document)), .text(field)]) { $0.text(0) }) ?? nil
      fields[key] = value
    }
    guard let value else { return nil }
    return JSString.slice(value, start, end)
  }
}

/// KWIC and sampling.
enum Passages {
  /// KWIC context on each side, in tokens (§4.4).
  static let kwicTokens = 12

  /// A KWIC row around [relStart, relEnd) of a passage text, clipped at the passage (`kwicAround`).
  static func kwicAround(_ text: String, _ relStart: Int, _ relEnd: Int, window: Int = kwicTokens) -> JSONObject {
    let t = Tokenizer.tokens(text)
    let starts = t.starts.map(Int.init), ends = t.ends.map(Int.init)
    var first = 0
    while first < starts.count && ends[first] <= relStart { first += 1 }
    var last = first
    while last < starts.count && starts[last] < relEnd { last += 1 }
    let leftFrom = first - window > 0 ? starts[first - window] : 0
    let rightTo = last + window - 1 < ends.count ? ends[last + window - 1] : JSString.length(text)
    return ["start": .int(relStart), "end": .int(relEnd), "left": .string(JSString.slice(text, leftFrom, relStart)),
            "match": .string(JSString.slice(text, relStart, relEnd)),
            "right": .string(JSString.slice(text, relEnd, max(relEnd, rightTo)))]
  }

  /// The lane key of a document for a facet ('collection:demo-world').
  static func laneOf(_ doc: ScopeDoc, _ coll: CollectionInfo, _ facet: String) -> String {
    let v: String? = switch facet {
    case "collection": coll.slug
    case "language": doc.langText
    case "domain": coll.domain
    case "modality": coll.modality
    case "date_basis": doc.basis
    case "kind": doc.kind
    case "community": doc.community
    case "culture": doc.culture
    case "field": doc.field
    default: nil
    }
    return "\(facet):\(v ?? "unknown")"
  }

  /// Fisher–Yates from the end with the reference's draws.
  static func shuffle(_ list: inout [Int], _ rng: inout Mulberry32) {
    var i = list.count - 1
    while i > 0 {
      let j = Int((rng.next() * Double(i + 1)).rounded(.down))
      list.swapAt(i, j)
      i -= 1
    }
  }

  /// Up to `count` KWIC rows from a slice, at most one per document (`samplePassages`).
  static func sample(_ c: Connection, _ scope: Scope, _ spec: SliceSpec, _ stats: SliceStats, rng: inout Mulberry32,
                     count: Int = 5, laneFacet: String = "collection", reader: inout PassageTextReader) throws -> [JSONValue] {
    let classes = Set(stats.classes)
    var docs = stats.perDoc.filter { $0.n > 0 }.map(\.id).sorted()
    shuffle(&docs, &rng)
    var out: [JSONValue] = []
    var tried = 0
    for docId in docs {
      if out.count >= count || tried >= 60 { break }
      tried += 1
      let doc = scope.docIndex[docId]!
      var occs: [(occ: Int, pid: Int, start: Int, end: Int, field: String, pStart: Int, pEnd: Int)] = []
      for e in scope.exprs {
        let rows = try c.rows(AnalysisSQL.docOccurrences, [.int(Int64(e.id)), .int(Int64(e.run)), .int(Int64(docId))]) { r in
          (occ: r.i(0), pid: r.i(1), start: r.i(2), end: r.i(3), nameFlag: r.i(4), field: r.text(5), fc: r.text(6),
           lang: r.text(7), quality: r.text(8), pStart: r.i(9), pEnd: r.i(10))
        }
        for o in rows where o.quality == "ok" && classes.contains(o.fc)
          && (stats.unit == "works" || spec.langOk(o.lang, o.fc, doc.langText)) && (scope.toggles.nm == 1 || o.nameFlag == 0) {
          occs.append((o.occ, o.pid, o.start, o.end, o.field, o.pStart, o.pEnd))
        }
      }
      if occs.isEmpty { continue }
      let o = occs[Int((rng.next() * Double(occs.count)).rounded(.down))]
      guard let text = reader.read(document: docId, field: o.field, start: o.pStart, end: o.pEnd) else { continue }
      let coll = scope.collections[doc.coll]!
      var row = kwicAround(text, o.start - o.pStart, o.end - o.pStart)
      row["passage"] = .int(o.pid)
      row["doc"] = .int(docId)
      row["occ"] = .int(o.occ)
      row["title"] = .str(doc.title)
      row["date"] = ["label": .string(doc.dateLabel), "precision": .string(doc.precision)]
      row["lane"] = .string(laneOf(doc, coll, laneFacet))
      row["collection"] = .string(coll.slug)
      row["kind"] = .string(doc.kind)
      row["synthetic"] = .bool(doc.syn)
      row["context_group"] = .null
      out.append(.object(row))
    }
    return out
  }
}
