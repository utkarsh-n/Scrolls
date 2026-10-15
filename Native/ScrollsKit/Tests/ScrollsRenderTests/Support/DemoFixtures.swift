// OWNER: N7
// The demo's real display lists for ScrollsRenderTests: the reference server's own TimelineQuery, tiles and marks of the
// committed golden family g5.inputs (m1r, the synthetic demo), checked against MANIFEST.json's sha256 before use, built
// through the same model, layout and display builder the app uses (phone geometry). No data is invented here.

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel

enum DemoFixtures {
  struct Missing: Error, CustomStringConvertible { let description: String }

  static let goldenDir: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("DifferentialTests/Golden")

  /// One query of g5.inputs, decoded.
  struct Input {
    var key: String
    var query: TimelineQueryResponse?
    var corpus: Corpus?
    var strands: [StrandPin]
    var labels: [String: String]
    var facet: String
    var tiles: [String: (answered: String, tiles: [Int64: TileSlot])]
    var marks: [String: MarksWindow]
  }

  static func inputs() throws -> [String: Input] {
    let manifestData = try Data(contentsOf: goldenDir.appendingPathComponent("MANIFEST.json"))
    let manifest = try JSONValue.parse(manifestData)
    guard let files = manifest["families"]?["g5.inputs"]?["files"]?.objectValue else { throw Missing(description: "g5.inputs is not in MANIFEST.json") }
    var out: [String: Input] = [:]
    for (file, sha) in files {
      let data = try Data(contentsOf: goldenDir.appendingPathComponent("g5.inputs").appendingPathComponent(file))
      let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard digest == sha.stringValue else { throw Missing(description: "g5.inputs/\(file): sha256 does not match the manifest") }
      for line in data.split(separator: UInt8(ascii: "\n")) where !line.isEmpty {
        let v = try JSONValue.parse(Data(line))
        guard let key = v["key"]?.stringValue else { continue }
        do {
          out[key] = try decode(v, key: key)
        } catch {
          throw Missing(description: "g5.inputs \(key): \(error)")
        }
      }
    }
    return out
  }

  static func decode(_ v: JSONValue, key: String) throws -> Input {
    func field<T: Decodable>(_ name: String, _ type: T.Type, _ value: JSONValue) throws -> T {
      do { return try ScrollsJSON.decode(type, from: value) } catch { throw Missing(description: "\(name): \(error)") }
    }
    // (JSONValue is ExpressibleByNilLiteral: test for null explicitly, never `? nil : $0`)
    var query: TimelineQueryResponse?
    if let q = v["query"], !q.isNull { query = try field("query", TimelineQueryResponse.self, q) }
    var corpus: Corpus?
    if let c = v["corpus_entry"], !c.isNull { corpus = try field("corpus_entry", Corpus.self, c) }
    let strands = (v["strands"]?.arrayValue ?? []).map {
      StrandPin(type: $0["type"]?.stringValue ?? "", id: $0["id"]?.stringValue ?? "", glyph: $0["glyph"]?.stringValue ?? "circle")
    }
    var labels: [String: String] = [:]
    for (k, x) in v["strandLabels"]?.objectValue ?? JSONObject() { labels[k] = x.stringValue }
    var tiles: [String: (String, [Int64: TileSlot])] = [:]
    for (tier, slot) in v["tiles"]?.objectValue ?? JSONObject() {
      var m: [Int64: TileSlot] = [:]
      for (k, t) in slot["tiles"]?.objectValue ?? JSONObject() {
        m[Int64(k)!] = t.isNull ? .empty : .data(try field("tile \(tier)/\(k)", Tile.self, t))
      }
      tiles[tier] = (slot["answered"]?.stringValue ?? tier, m)
    }
    var marks: [String: MarksWindow] = [:]
    for (k, m) in v["marks"]?.objectValue ?? JSONObject() {
      let items = try (m["items"]?.arrayValue ?? []).map { try field("marks \(k)", Mark.self, $0) }
      marks[k] = MarksWindow(items: items, fromDay: m["fromDay"]?.safeInteger ?? 0, toDay: m["toDay"]?.safeInteger ?? 0,
                             truncated: m["truncated"]?.boolValue ?? false)
    }
    return Input(key: key, query: query, corpus: corpus, strands: strands, labels: labels,
                 facet: v["request"]?["lanes"]?["facet"]?.stringValue ?? "community", tiles: tiles, marks: marks)
  }

  /// The data's extent and the focus day the generator centres fine tiers on (gen-display.mjs `extentOf`, `focus`).
  static func extent(_ input: Input) -> (lo: Double, hi: Double, focus: Double) {
    guard let q = input.query else {
      return (Double(DayMath.dayFromYMD(1880, 1, 1)), Double(DayMath.dayFromYMD(2026, 12, 31)), Double(DayMath.dayFromYMD(1953, 1, 1)))
    }
    let lo = q.lanes.compactMap { $0.first?.loDay }.min() ?? 0, hi = q.lanes.compactMap { $0.last?.hiDay }.max() ?? 0
    let firsts = q.lanes.compactMap { $0.first?.loDay }.sorted()
    let focus = firsts.isEmpty ? Double(lo + hi) / 2 : Double(firsts[firsts.count / 2])
    return (Double(lo), Double(hi), focus)
  }

  /// A phone build of one query at a tier's middle zoom (centred as gen-display.mjs centres it), `width` points wide.
  static func build(_ input: Input, tier asked: Tier, width: Double, lanesHeight: Double) -> (build: DisplayBuild, axis: ScrollAxis) {
    let ext = extent(input)
    let centre = asked.rawValue <= 2 ? (ext.lo + ext.hi) / 2 : ext.focus
    let axis = ScrollAxis(centerDay: centre, daysPerPoint: 1 / asked.midPointsPerDay).clamped(width: width)
    let tier = axis.tier
    let sc = axis.scale(width: width)
    let span = sc.hiDay - sc.loDay
    let range = (sc.loDay - span)...(sc.hiDay + span), visible = sc.loDay...sc.hiDay
    var model: TimelineModel
    if let q = input.query {
      let answered = input.tiles[tier.code]?.answered ?? tier.code
      let drawTier = Tier(code: answered) ?? tier
      let tiles = input.tiles[answered]?.tiles ?? [:]
      func mk(_ marks: MarksWindow?) -> TimelineModel {
        ScrollModelBuilder.build(ModelInput(query: q, tier: drawTier, tiles: tiles, range: range, visible: visible, strands: input.strands,
                                            marks: marks, strandLabels: input.labels, laneLimit: 5,
                                            lanesView: LanesView(facet: input.facet, order: "first_observed")))
      }
      model = mk(nil)
      if model.wantMarks {
        let r = model.rangeN <= ScrollModelBuilder.maxMarks ? range : visible
        let key = "\(DayMath.ymdFromDay(Int(r.lowerBound.rounded(.down))).y - 1)|\(DayMath.ymdFromDay(Int(r.upperBound.rounded(.down))).y + 1)"
        if let marks = input.marks[key] { model = mk(marks) }
      }
    } else {
      model = ScrollModelBuilder.coverageModel(collections: input.corpus?.collections ?? [], synthetic: input.corpus?.synthetic ?? false, tier: tier)
    }
    let layout = LaneLayouts.phone(keys: model.lanes.map(\.key), strandCount: max(1, model.rowCount), moreRow: model.hiddenLanes > 0,
                                   fillHeight: lanesHeight)
    let b = DisplayBuilder.buildSync(DisplayInput(model: model, originDay: range.lowerBound, daysPerPoint: axis.daysPerPoint,
                                                  width: (range.upperBound - range.lowerBound) / axis.daysPerPoint, layout: layout,
                                                  seams: input.query?.seams ?? [], rulerHeight: 28, coverageHeight: 10))
    return (b, axis)
  }
}
