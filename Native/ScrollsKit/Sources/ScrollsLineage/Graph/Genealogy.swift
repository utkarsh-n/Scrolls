// OWNER: N5
// Port of server/lineage/genealogy.mjs (SPEC §2.C2): the sampling family tree, works mode of the Lineage explorer.
//
// One row per work, grouped by generation from the seed (+1 = works that sample, interpolate, cover, remix or version
// it; −1 = what it sampled), sorted by date inside a generation, with a per-decade density count. Defaults: types
// {samples, interpolates, cover_of, remix_of, version_of}; documented only; depth ≤ 3 each way; ≤ 150 rows (the rest are
// counted and paged). Every edge carries its source dataset and locator. Absence of a link is never read as absence of
// sampling (the note says so).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

public enum Genealogy {
  public static let defaultTypes = ["samples", "interpolates", "cover_of", "remix_of", "version_of"]
  public static let maxRows = 150
  public static let maxDepth = 3
  static let maxSeeds = 500
  static let noteReal = "Documented links from Wikipedia, MusicBrainz, Wikidata and ItwoFS as collected by Cipher. Absence of a link is not evidence of no sampling."
  static let noteSynthetic = "Documented links from the synthetic world's records. Absence of a link is not evidence of no sampling."
  static let noteEmpty = "No documented sample, cover, remix or version links. Absence of a link is not evidence of no sampling."

  /// `decadeOf(y)`: the first year of the decade holding an astronomical year (1994 → 1990; −5 → −10).
  static func decadeOf(_ y: Int64) -> Int64 { Int64((Double(y) / 10).rounded(.down)) * 10 }

  struct Doc {
    var id: Int64
    var title: String?
    var author: String?
    var kind: String?
    var yLo: Int64?
    var precision: String
    var dateLabel: String
    var chronoStatus: String
    var isSynthetic: Int64
    var collection: String
    var rateEligible: Int64
  }

  static func doc(_ c: Connection, _ id: Int64) throws -> Doc? {
    try c.prepared(LineageSQL.genealogyDocument).bindingFirst([.int(id)]) { r in
      Doc(id: r.int(0), title: r.textOrNil(1), author: r.textOrNil(2), kind: r.textOrNil(3), yLo: r.intOrNil(4),
          precision: r.text(6), dateLabel: r.text(7), chronoStatus: r.text(8), isSynthetic: r.int(9), collection: r.text(11),
          rateEligible: r.int(12))
    }
  }

  /// `makerWorks(db, maker)`: documents whose author is the name, or that carry it as a maker tag; a search
  /// suggestion's slug (`maker:<slugify(name)>`) is resolved to the names with that slug. Ids by date, undated last, ≤ 500.
  static func makerWorks(_ c: Connection, _ maker: String) throws -> (name: String, ids: [Int64]) {
    func byNames(_ names: [String]) throws -> [Int64] {
      try c.prepared(LineageSQL.makerWorksByNames).binding([.text(LineageJS.jsonList(names))]) { $0.int(0) }
    }
    let exact = try byNames([maker])
    if !exact.isEmpty || !isSlug(maker) { return (maker, exact) }
    let words = JSString.split(maker, "-").filter { !$0.isEmpty }
    if words.isEmpty { return (maker, []) }
    let like = "%" + words.joined(separator: "%") + "%"
    let names = try c.prepared(LineageSQL.makerNamesLike).binding([.text(like)]) { $0.textOrNil(0) }
      .compactMap { $0 }.filter { JSString.equal(IDs.slug($0), maker) }
    return (names.first ?? maker, names.isEmpty ? [] : try byNames(names))
  }

  /// `/^[\p{Ll}\p{N}-]+$/u`.
  static func isSlug(_ s: String) -> Bool {
    guard !s.isEmpty else { return false }
    return s.unicodeScalars.allSatisfy { u in
      u == "-" || u.properties.generalCategory == .lowercaseLetter || [.decimalNumber, .letterNumber, .otherNumber]
        .contains(u.properties.generalCategory)
    }
  }

  /// `docOfRef`: the document behind a relationship endpoint (works are documents; passage endpoints resolve to theirs).
  static func docOfRef(_ c: Connection, _ type: String, _ ref: String) throws -> Int64? {
    if type == "document" {
      let n = JSNumber.parse(ref)
      return n.isFinite && n.rounded(.towardZero) == n ? Int64(n) : nil
    }
    if type == "passage" {
      let n = JSNumber.parse(ref)
      guard n.isFinite, n.rounded(.towardZero) == n else { return nil }
      return try c.prepared(LineageSQL.passageDocument).bindingFirst([.int(Int64(n))]) { $0.int(0) }
    }
    return nil
  }

  final class Row {
    var gen: Int
    var doc: Int64
    var title: String
    var maker: String?
    var kind: String?
    var date: JSONValue
    var y: Int64?
    var undated: Bool
    var edges: [JSONValue]
    var edgeIDs: Set<Int64>
    var collection: String
    var rateEligible: Bool
    var synthetic: Bool
    init(gen: Int, d: Doc, edge: JSONValue, edgeID: Int64) {
      self.gen = gen
      doc = d.id
      title = d.title ?? "document \(d.id)"
      maker = d.author
      kind = d.kind
      date = ["label": .string(d.dateLabel), "precision": .string(d.precision)]
      y = d.yLo
      undated = d.chronoStatus != "dated"
      edges = [edge]
      edgeIDs = [edgeID]
      collection = d.collection
      rateEligible = d.rateEligible == 1
      synthetic = d.isSynthetic == 1
    }
    var json: JSONValue {
      ["doc": .number(Double(doc)), "title": .string(title), "maker": maker.map(JSONValue.string) ?? .null,
       "kind": kind.map(JSONValue.string) ?? .null, "date": date, "undated": .bool(undated), "edges": .array(edges),
       "collection": .string(collection), "rate_eligible": .bool(rateEligible), "synthetic": .bool(synthetic)]
    }
  }

  /// `genealogyQuery(db, args)`: GET /api/genealogy?work=document:61002|maker=<name>&dir=forward|back|both&depth=&types=
  /// &status=&max=&cursor=. `forward` = later works that reuse the seed (+1, +2, …); `back` = what the seed reused.
  public static func query(_ c: Connection, _ args: QueryArgs) throws -> JSONValue {
    var seeds: [Int64]
    var seedJSON: JSONValue
    if let maker = args["maker"], !maker.isEmpty {
      let found = try makerWorks(c, maker)
      seeds = found.ids
      guard !seeds.isEmpty, let first = try doc(c, seeds[0]) else {
        throw ScrollsError.lineageNotFound("No works by \(maker).")
      }
      seedJSON = ["doc": .number(Double(first.id)),
                  "title": .string("\(found.name) — \(seeds.count) work\(seeds.count == 1 ? "" : "s")"),
                  "maker": .string(found.name), "year": first.yLo.map { .number(Double($0)) } ?? .null,
                  "works": .number(Double(seeds.count))]
    } else {
      let work = args["work"] ?? ""
      guard let id = documentRef(work) else {
        throw ScrollsError.lineageInvalid("work must be a reference like 'document:61002' (or give maker=).", field: "work")
      }
      guard let d = try doc(c, id) else { throw ScrollsError.lineageNotFound("No work \(work).") }
      seeds = [d.id]
      seedJSON = ["doc": .number(Double(d.id)), "title": .string(d.title ?? "document \(d.id)"),
                  "maker": d.author.map(JSONValue.string) ?? .null, "year": d.yLo.map { .number(Double($0)) } ?? .null,
                  "date": ["label": .string(d.dateLabel), "precision": .string(d.precision)]]
    }
    let dir = ["forward", "back", "both"].contains(args["dir"] ?? "") ? args["dir"]! : "both"
    let depth = Swift.min(maxDepth, Swift.max(1, LineageJS.parseIntOr(args["depth"], 3)))
    let max = Swift.min(maxRows, Swift.max(1, LineageJS.parseIntOr(args["max"], maxRows)))
    var fargs = args
    fargs["types"] = args["types"] ?? defaultTypes.joined(separator: ",")
    fargs["status"] = args["status"] ?? "documented"
    let f = try EdgeFilters(fargs)
    let offset = try cursorOffset(args["cursor"])

    // breadth-first over document-level links, by generation (+ forward, − back)
    var placed: [Int64: Int] = [:]
    for id in seeds where placed[id] == nil { placed[id] = 0 }
    var rows: [Row] = []
    var rowAt: [String: Row] = [:]
    func walk(_ sign: Int) throws {
      var frontier = seeds
      var g = 1
      while g <= depth && !frontier.isEmpty {
        var next: [Int64] = []
        for docId in frontier {
          var refs: [(String, String)] = [("document", String(docId))]
          refs += try c.prepared(LineageSQL.documentPassageIDs).binding([.int(docId)]) { ("passage", String($0.int(0))) }
          for (type, ref) in refs {
            let rels = try Edges.asOf(c, f, try Edges.rows(c, sign > 0 ? LineageSQL.edgesTo : LineageSQL.edgesFrom,
                                                           .text(type), .text(ref), f))
            for r in rels {
              let other = sign > 0 ? try docOfRef(c, r.srcType, r.srcRef) : try docOfRef(c, r.dstType, r.dstRef)
              guard let other, other != docId else { continue }
              let edge: JSONValue = [
                "rel_id": .number(Double(r.id)), "rel_type": .string(r.relType), "evidence_status": .string(r.evidenceStatus),
                "review_status": .string(r.reviewStatus), "source_dataset": r.sourceDataset.map(JSONValue.string) ?? .null,
                "locator": r.sourceLocator.map(JSONValue.string) ?? .null, "provenance_quality": .string(r.provenanceQuality),
                "date_conflict": .bool(r.dateConflict == 1), "parent": .number(Double(docId)),
              ]
              let key = "\(other):\(sign * g)"
              if let existing = rowAt[key] {
                if existing.edgeIDs.insert(r.id).inserted { existing.edges.append(edge) }
                continue
              }
              if placed[other] != nil { continue }
              guard let d = try doc(c, other) else { continue }
              placed[other] = sign * g
              let row = Row(gen: sign * g, d: d, edge: edge, edgeID: r.id)
              rows.append(row)
              rowAt[key] = row
              next.append(other)
            }
          }
        }
        frontier = next
        g += 1
      }
    }
    if dir != "back" { try walk(1) }
    if dir != "forward" { try walk(-1) }

    var byGen: [Int: [Row]] = [:]
    var genOrder: [Int] = []
    for r in rows {
      if byGen[r.gen] == nil { genOrder.append(r.gen) }
      byGen[r.gen, default: []].append(r)
    }
    let gens = genOrder.sorted { a, b in
      let sa = a.signum(), sb = b.signum()
      return sa != sb ? sa < sb : abs(a) < abs(b)
    }
    var budget = max, skipped = offset, hiddenRows = 0
    var generations: [JSONValue] = []
    var shown = 0
    for gen in gens {
      let all = (byGen[gen] ?? []).sorted { a, b in
        if a.undated != b.undated { return !a.undated }
        let ya = a.y ?? 0, yb = b.y ?? 0
        if ya != yb { return ya < yb }
        return a.doc < b.doc
      }
      var byDecade = JSONObject()
      for r in all where !r.undated {
        guard let y = r.y else { continue }
        let k = String(decadeOf(y))
        byDecade[k] = .number((byDecade[k]?.numberValue ?? 0) + 1)
      }
      let undated = all.filter(\.undated).count
      let start = Swift.min(all.count, skipped)
      skipped -= start
      let take = Array(all[start..<Swift.min(all.count, start + budget)])
      budget -= take.count
      hiddenRows += all.count - start - take.count
      guard !all.isEmpty else { continue }
      shown += take.count
      generations.append(["gen": .number(Double(gen)), "total": .number(Double(all.count)), "returned": .number(Double(take.count)),
                          "by_decade": .object(byDecade), "undated": .number(Double(undated)),
                          "rows": .array(take.map(\.json))])
    }
    let shownSoFar = offset + shown
    let anySynthetic = try doc(c, seeds[0])?.isSynthetic == 1
    let cursor: JSONValue = hiddenRows > 0 ? .string(encodeCursor(shownSoFar)) : .null
    return [
      "seed": seedJSON,
      "generations": .array(generations),
      "truncated": ["rows": .number(Double(hiddenRows)), "cursor": cursor],
      "filters": ["dir": .string(dir), "depth": .number(Double(depth)), "max": .number(Double(max)), "types": f.typesJSON,
                  "status": f.statusJSON],
      "note": .string(rows.isEmpty ? noteEmpty : anySynthetic ? noteSynthetic : noteReal),
      "synthetic": .bool(anySynthetic),
    ]
  }

  /// `/^document:(\d+)$/`.
  static func documentRef(_ s: String) -> Int64? {
    guard JSString.hasPrefix(s, "document:") else { return nil }
    let digits = String(String.UnicodeScalarView(s.unicodeScalars.dropFirst(9)))
    guard !digits.isEmpty, digits.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return nil }
    let n = JSNumber.parse(digits)
    return n.isFinite && n <= 9_007_199_254_740_991 ? Int64(n) : nil
  }

  /// `Buffer.from(JSON.stringify({offset})).toString('base64url')`.
  static func encodeCursor(_ offset: Int) -> String {
    Data("{\"offset\":\(offset)}".utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  /// The cursor's offset: `Math.max(0, Number(JSON.parse(base64url).offset) || 0)`; E_BAD_CURSOR when it is not JSON.
  static func cursorOffset(_ cursor: String?) throws -> Int {
    guard let cursor, !cursor.isEmpty else { return 0 }
    var b64 = cursor.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    guard let data = Data(base64Encoded: b64), let v = try? JSONValue.parse(data) else {
      throw ScrollsError(code: .badCursor, message: "The cursor is not one this server issued.",
                         hint: "Restart the list without a cursor.", status: 400)
    }
    let raw = v["offset"]
    let n: Double = switch raw {
    case .number(let x)?: x
    case .string(let s)?: JSNumber.parse(s)
    case .bool(let b)?: b ? 1 : 0
    case .null?: 0
    default: .nan
    }
    let o = n.isNaN || n == 0 ? 0 : n
    return Swift.max(0, Int(o.rounded(.towardZero)))
  }
}
