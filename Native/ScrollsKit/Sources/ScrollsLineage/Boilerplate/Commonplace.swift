// OWNER: N5
// Port of server/lineage/commonplace.mjs (SPEC §2.C, §4.7): the "widely shared text (n documents)" node. The
// boilerplate pass finds widespread fingerprint groups (> 25 documents) that are not boilerplate — Bible verses,
// proverbs, set phrases — and records, per passage made mostly of them, the most widely shared group. Lineage collapses
// such text into one node instead of drawing n² quotation edges; the reuse index never pairs groups of more than 25
// documents. The record is a derived file per pass scope (`derived/reuse/commonplace-<scope>.json` beside the atlas,
// i.e. AtlasLocation.derivedDir on the phone), rewritten by every pass over that scope; readers merge the files.

import Foundation
import ScrollsContracts
import ScrollsCore
import Synchronization

/// One pass's commonplace record.
public struct CommonplaceRecord: Sendable, Equatable {
  public struct Entry: Sendable, Equatable {
    public var key: String
    public var docs: Int
  }
  public struct Group: Sendable, Equatable {
    public var docs: Int
    /// At most 50 passages, in slot order.
    public var passages: [Int64]
  }
  public var run: Int64?
  public var collections: [String]?
  public var at: String
  public var passages: [Int64: Entry]
  public var groups: [String: Group]

  public init(run: Int64?, collections: [String]?, at: String, passages: [Int64: Entry], groups: [String: Group]) {
    self.run = run
    self.collections = collections
    self.at = at
    self.passages = passages
    self.groups = groups
  }

  /// The file's JSON (`{run, collections, at, passages, groups}`).
  public var json: JSONValue {
    var ps = JSONObject()
    for (id, e) in passages { ps[String(id)] = ["key": .string(e.key), "docs": .number(Double(e.docs))] }
    var gs = JSONObject()
    for (k, g) in groups {
      gs[k] = ["docs": .number(Double(g.docs)), "passages": .array(g.passages.map { .number(Double($0)) })]
    }
    return ["run": run.map { .number(Double($0)) } ?? .null,
            "collections": collections.map { .array($0.map(JSONValue.string)) } ?? .null,
            "at": .string(at), "passages": .object(ps), "groups": .object(gs)]
  }

  init?(json v: JSONValue) {
    guard let at = v["at"]?.stringValue else { return nil }
    self.at = at
    run = v["run"]?.safeInteger.map(Int64.init)
    collections = v["collections"]?.arrayValue?.compactMap(\.stringValue)
    var ps: [Int64: Entry] = [:]
    for (k, e) in v["passages"]?.objectValue ?? JSONObject() {
      guard let id = Int64(k), let key = e["key"]?.stringValue, let docs = e["docs"]?.safeInteger else { continue }
      ps[id] = Entry(key: key, docs: docs)
    }
    passages = ps
    var gs: [String: Group] = [:]
    for (k, g) in v["groups"]?.objectValue ?? JSONObject() {
      guard let docs = g["docs"]?.safeInteger else { continue }
      gs[k] = Group(docs: docs, passages: (g["passages"]?.arrayValue ?? []).compactMap { $0.safeInteger.map(Int64.init) })
    }
    groups = gs
  }
}

/// The collapsed node of a widespread non-boilerplate group (`commonplaceNode`).
public struct CommonplaceNode: Sendable, Equatable {
  /// `shared:<8 hex>`
  public var id: String
  public var label: String
  public var documents: Int
  public var passages: [Int64]
  public var runs: [Int64?]
}

/// Reads and writes the commonplace records of an atlas.
public enum Commonplaces {
  static let prefix = "commonplace-"

  /// `derived/reuse` beside the database at `atlasPath` (the reference's `paths().reuse`).
  public static func directory(atlasPath: String) -> URL {
    URL(fileURLWithPath: atlasPath).deletingLastPathComponent().appendingPathComponent("derived")
      .appendingPathComponent("reuse")
  }

  /// `scopeKey(collections)`: the slug of the sorted collection list, or 'all'.
  public static func scopeKey(_ collections: [String]?) -> String {
    guard let c = collections, !c.isEmpty else { return "all" }
    let sorted = c.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    return IDs.slug(sorted.joined(separator: "+"), max: 80)
  }

  /// `writeCommonplaces(record)`: atomic replace of the scope's file.
  public static func write(_ record: CommonplaceRecord, atlasPath: String) throws {
    let dir = directory(atlasPath: atlasPath)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent("\(prefix)\(scopeKey(record.collections)).json")
    try Data(CanonicalJSON.string(record.json).utf8).write(to: file, options: .atomic)
    cache.withLock { $0[file.path] = nil }
  }

  private static let cache = Mutex<[String: (mtime: Date, record: CommonplaceRecord)]>([:])

  /// Every pass record, merged in file-name order (later files win for the same passage or group); nil when none.
  public static func load(atlasPath: String) -> (passages: [Int64: CommonplaceRecord.Entry],
                                                 groups: [String: CommonplaceRecord.Group], runs: [Int64?])? {
    let dir = directory(atlasPath: atlasPath)
    let fm = FileManager.default
    guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return nil }
    let files = names.filter { $0.hasPrefix(prefix) && $0.hasSuffix(".json") }
      .sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    guard !files.isEmpty else { return nil }
    var passages: [Int64: CommonplaceRecord.Entry] = [:]
    var groups: [String: CommonplaceRecord.Group] = [:]
    var runs: [Int64?] = []
    for f in files {
      let path = dir.appendingPathComponent(f).path
      guard let mtime = (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date else { continue }
      var record = cache.withLock { c -> CommonplaceRecord? in
        guard let hit = c[path], hit.mtime == mtime else { return nil }
        return hit.record
      }
      if record == nil {
        guard let data = fm.contents(atPath: path), let v = try? JSONValue.parse(data), let r = CommonplaceRecord(json: v)
        else { continue }
        record = r
        cache.withLock { $0[path] = (mtime, r) }
      }
      guard let r = record else { continue }
      passages.merge(r.passages) { _, new in new }
      groups.merge(r.groups) { _, new in new }
      runs.append(r.run)
    }
    return (passages, groups, runs)
  }

  /// `commonplaceFor(passageIds)`: the commonplace group of each passage made mostly of widely shared text.
  public static func groups(of passageIDs: [Int64], atlasPath: String) -> [Int64: CommonplaceRecord.Entry] {
    guard let data = load(atlasPath: atlasPath) else { return [:] }
    var out: [Int64: CommonplaceRecord.Entry] = [:]
    for id in passageIDs { if let e = data.passages[id] { out[id] = e } }
    return out
  }

  /// `commonplaceNode(groupKey)`: the collapsed node; E_NOT_FOUND when no pass recorded the group.
  public static func node(_ groupKey: String, atlasPath: String) throws -> CommonplaceNode {
    guard let data = load(atlasPath: atlasPath), let g = data.groups[groupKey] else {
      throw ScrollsError(code: .notFound, message: "No widely shared text \(groupKey).", hint: "Run the boilerplate pass first.",
                         detail: nil, status: 404)
    }
    return CommonplaceNode(id: "shared:\(groupKey)", label: "widely shared text (\(g.docs) documents)", documents: g.docs,
                           passages: g.passages, runs: data.runs)
  }
}
