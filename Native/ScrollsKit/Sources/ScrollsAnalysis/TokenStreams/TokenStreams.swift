// OWNER: N4
// Token-id streams per language (server/analysis/tokstream.mjs; SPEC §4.7): in `derived/tokens/`, the reference's own
// layout, so the engine reads streams the reference built (a snapshot clone) and writes ones the reference can read:
//   <lang>.u32        one u32 id per token of every quality='ok' passage of that language, in passage-id order
//   <lang>.pidx       u32 pairs (passage id, offset of its first token in .u32), by passage id
//   <lang>.vocab.tsv  id \t token \t count; ids are frequency ranks (0 = most frequent; ties by token, code units)
//   <lang>.json       manifest: data version, content signature, tokenizer, counts, byte order, run id
// A stream is current while the passages it holds are unchanged (`streamSignature`). Ranges of ids are read with pread,
// never mapped whole (the English stream of a full atlas is hundreds of MB; IOS-SPEC §3.8 mapping budget).

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore
import Synchronization

/// The token streams of one atlas.
public enum TokenStreams {
  /// Pipeline version recorded on tokstream runs and manifests.
  public static let version = "tokstream@1.0.0"

  struct Files {
    let ids: URL, pidx: URL, vocab: URL, manifest: URL
  }

  static func files(_ dir: URL, _ lang: String) throws -> Files {
    let ok = !lang.isEmpty && lang.utf8.count <= 32
      && lang.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x2D }
    guard ok else { throw ScrollsError.badRequest(.validation, "bad stream language '\(lang)'") }
    return Files(ids: dir.appendingPathComponent("\(lang).u32"), pidx: dir.appendingPathComponent("\(lang).pidx"),
                 vocab: dir.appendingPathComponent("\(lang).vocab.tsv"), manifest: dir.appendingPathComponent("\(lang).json"))
  }

  /// The manifest of a language's stream, or nil.
  static func manifest(_ dir: URL, _ lang: String) -> JSONObject? {
    guard let f = try? files(dir, lang), let data = try? Data(contentsOf: f.manifest) else { return nil }
    return (try? JSONValue.parse(data))?.objectValue
  }

  /// `JSON.stringify` of a string (the signature key is plain JSON.stringify, not canonical JSON).
  static func jsonString(_ s: String) -> String { CanonicalJSON.string(.string(s)) }

  /// What a stream's content depends on (`streamSignature`): the passages' highest id, the import batches by status,
  /// the passage-quality version, the tokenizer and the segmenter.
  public static func signature(_ c: Connection) throws -> String {
    let maxPassage = try c.first(AnalysisSQL.maxPassage) { $0.isNull(0) ? 0 : $0.i(0) } ?? 0
    let batches = try c.rows(AnalysisSQL.batchStatus) { r in
      "\(r.text(0)):\(r.i(1)):\(r.isNull(2) ? "null" : String(r.i(2)))"
    }
    let quality = try c.metaValue("quality_version") ?? "0"
    let key = "{\"maxPassage\":\(maxPassage),\"batches\":[\(batches.map(jsonString).joined(separator: ","))],"
      + "\"quality\":\(jsonString(quality)),\"tokenizer\":\(jsonString(Tokenizer.version)),\"segmenter\":\"seg-1\"}"
    return String(sha256Hex(key).prefix(32))
  }

  /// Whether a stream matches the database now.
  public struct Status: Sendable {
    public var exists: Bool
    public var fresh: Bool
    public var builtAtDataVersion: JSONValue
    public var dataVersion: Int

    /// The words the reference prints for a stream's state.
    public var words: String {
      !exists ? "not built" : fresh ? "current"
        : "out of date (built at data version \(CanonicalJSON.string(builtAtDataVersion)), now \(dataVersion))"
    }
  }

  /// `streamStatus(db, dir, lang)`.
  public static func status(_ c: Connection, _ dir: URL?, _ lang: String) throws -> Status {
    let dv = try Meta.dataVersion(c)
    guard let dir, let m = manifest(dir, lang) else {
      return Status(exists: false, fresh: false, builtAtDataVersion: .null, dataVersion: dv)
    }
    let same: Bool
    if case .string(let sig)? = m["signature"], !sig.isEmpty {
      same = sig == (try signature(c))
    } else {
      same = m["data_version"]?.numberValue == Double(dv)
    }
    let fresh = same && m["tokenizer"]?.stringValue == Tokenizer.version && m["byte_order"]?.stringValue == "LE"
    return Status(exists: true, fresh: fresh, builtAtDataVersion: m["data_version"] ?? .null, dataVersion: dv)
  }

  // ── reading ──

  /// The index and vocabulary of a written stream, cached per (directory, language, built_at).
  final class Base: @unchecked Sendable {
    let passages: [UInt32]
    let offsets: [UInt32]
    let vocab: [String]
    let counts: [UInt32]
    let tokens: Int
    let index: [JSKey: Int]

    init(passages: [UInt32], offsets: [UInt32], vocab: [String], counts: [UInt32], tokens: Int) {
      self.passages = passages
      self.offsets = offsets
      self.vocab = vocab
      self.counts = counts
      self.tokens = tokens
      var index: [JSKey: Int] = [:]
      index.reserveCapacity(vocab.count)
      for (i, t) in vocab.enumerated() { index[JSKey(t)] = i }
      self.index = index
    }
  }

  private static let cache = Mutex<[String: (builtAt: String, base: Base)]>([:])

  static func readUInt32(_ url: URL) throws -> [UInt32] {
    let data = try Data(contentsOf: url)
    return data.withUnsafeBytes { raw in Array(raw.bindMemory(to: UInt32.self)) }.map { UInt32(littleEndian: $0) }
  }

  /// An open stream: ranges of ids are read from the file on demand.
  public final class Stream {
    let base: Base
    private let handle: FileHandle

    init(base: Base, idsFile: URL) throws {
      self.base = base
      handle = try FileHandle(forReadingFrom: idsFile)
    }

    deinit { try? handle.close() }

    var vocab: [String] { base.vocab }
    func idOf(_ token: String) -> Int? { base.index[JSKey(token)] }

    /// The [start, end) token range of a passage, or nil.
    func range(_ passageId: Int) -> (Int, Int)? {
      var lo = 0, hi = base.passages.count - 1
      let p = UInt32(truncatingIfNeeded: passageId)
      while lo <= hi {
        let mid = (lo + hi) >> 1
        if base.passages[mid] < p { lo = mid + 1 } else if base.passages[mid] > p { hi = mid - 1 } else {
          return (Int(base.offsets[mid]), mid + 1 < base.passages.count ? Int(base.offsets[mid + 1]) : base.tokens)
        }
      }
      return nil
    }

    func readIds(_ start: Int, _ end: Int) throws -> [Int] {
      guard end > start else { return [] }
      try handle.seek(toOffset: UInt64(start * 4))
      let data = try handle.read(upToCount: (end - start) * 4) ?? Data()
      return data.withUnsafeBytes { raw in raw.bindMemory(to: UInt32.self).map { Int(UInt32(littleEndian: $0)) } }
    }
  }

  /// `openTokenStream(lang, {dir, ids: false})`.
  static func open(_ dir: URL, _ lang: String) throws -> Stream {
    let f = try files(dir, lang)
    guard let m = manifest(dir, lang) else {
      throw ScrollsError(code: ErrorCode(rawValue: "E_NO_STREAM"), message: "No token stream for '\(lang)' in \(dir.path).")
    }
    let key = "\(dir.path)|\(lang)"
    let builtAt = m["built_at"]?.stringValue ?? ""
    if let hit = cache.withLock({ $0[key] }), hit.builtAt == builtAt { return try Stream(base: hit.base, idsFile: f.ids) }
    let raw = try readUInt32(f.pidx)
    let n = raw.count / 2
    var passages = [UInt32](repeating: 0, count: n), offsets = [UInt32](repeating: 0, count: n)
    for i in 0..<n {
      passages[i] = raw[2 * i]
      offsets[i] = raw[2 * i + 1]
    }
    let text = try String(contentsOf: f.vocab, encoding: .utf8)
    var vocabPairs: [(Int, String)] = []
    var counts: [UInt32] = []
    for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
      guard let t1 = line.firstIndex(of: "\t"), let t2 = line.lastIndex(of: "\t") else { continue }
      vocabPairs.append((Int(line[..<t1]) ?? 0, String(line[line.index(after: t1)..<t2])))
      counts.append(UInt32(line[line.index(after: t2)...]) ?? 0)
    }
    var vocab = [String](repeating: "", count: vocabPairs.count)
    for (i, t) in vocabPairs where i < vocab.count { vocab[i] = t }
    let size = (try FileManager.default.attributesOfItem(atPath: f.ids.path)[.size] as? Int) ?? 0
    let base = Base(passages: passages, offsets: offsets, vocab: vocab, counts: counts, tokens: size / 4)
    cache.withLock { $0[key] = (builtAt, base) }
    return try Stream(base: base, idsFile: f.ids)
  }

  // ── writing (the tokstream job) ──

  /// The result of a build.
  public struct BuildResult: Sendable {
    public var dataVersion: Int
    public var langs: [(lang: String, passages: Int, tokens: Int, types: Int)]
    public var json: JSONValue {
      ["data_version": .int(dataVersion), "langs": .array(langs.map {
        ["lang": .string($0.lang), "passages": .int($0.passages), "tokens": .int($0.tokens), "types": .int($0.types)]
      })]
    }
  }

  /// Writes the streams of quality='ok' passages for `langs` (nil = every language with ok passages) into `dir`
  /// (`buildTokenStreams`). Reads one snapshot; files are written under temporary names and renamed, manifest last.
  public static func build(_ c: Connection, text: any TextStore, dir: URL, langs wanted: [String]?, runID: Int?,
                           checkpoint: () throws -> Void = {}, progress: (Double, String) -> Void = { _, _ in }) throws -> BuildResult {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let dv = try Meta.dataVersion(c)
    let sig = try signature(c)
    let all = try c.rows(AnalysisSQL.streamLanguages) { r in (lang: r.text(0), tokens: r.i(2)) }
    let langs = wanted ?? all.map(\.lang)
    var totals: [String: Int] = [:]
    for r in all { totals[r.lang] = r.tokens }
    let grand = max(1, langs.reduce(0) { $0 + (totals[$1] ?? 0) })
    var done = 0
    var out: [(lang: String, passages: Int, tokens: Int, types: Int)] = []
    for lang in langs {
      let r = try writeOne(c, text: text, lang: lang, dir: dir, dv: dv, signature: sig, runID: runID, checkpoint: checkpoint) { n in
        done += n
        progress(min(0.99, Double(done) / Double(grand)), "\(lang): \(done) of \(grand) tokens")
      }
      out.append(r)
    }
    progress(1, "\(out.count) language stream(s) written")
    return BuildResult(dataVersion: dv, langs: out)
  }

  static func writeOne(_ c: Connection, text: any TextStore, lang: String, dir: URL, dv: Int, signature: String, runID: Int?,
                       checkpoint: () throws -> Void, onTokens: (Int) -> Void) throws -> (lang: String, passages: Int, tokens: Int, types: Int) {
    let f = try files(dir, lang)
    let pid = ProcessInfo.processInfo.processIdentifier
    func tmp(_ u: URL) -> URL { u.deletingLastPathComponent().appendingPathComponent("\(u.lastPathComponent).tmp-\(pid)") }
    var index: [JSKey: Int] = [:]
    var words: [String] = []
    var counts: [Int] = []
    var provisional: [UInt32] = []
    var pidx: [UInt32] = []
    var total = 0, passages = 0
    var lastCheck = ContinuousClock.now
    try checkpoint()
    let rows = try c.rows(AnalysisSQL.streamPassages, [.text(lang)]) { r in
      (id: r.i(0), doc: r.i(1), field: r.text(2), start: r.i(3), end: r.i(4))
    }
    var reader = PassageTextReader(c, text)
    for p in rows {
      pidx.append(UInt32(truncatingIfNeeded: p.id))
      pidx.append(UInt32(truncatingIfNeeded: total))
      passages += 1
      guard let src = reader.read(document: p.doc, field: p.field, start: p.start, end: p.end) else { continue }
      let tokens = Tokenizer.tokens(src).tokens
      for t in tokens {
        let k = JSKey(t)
        let id: Int
        if let known = index[k] { id = known } else {
          id = words.count
          index[k] = id
          words.append(t)
          counts.append(0)
        }
        counts[id] += 1
        provisional.append(UInt32(id))
      }
      total += tokens.count
      onTokens(tokens.count)
      if ContinuousClock.now - lastCheck >= .milliseconds(100) {
        lastCheck = .now
        try checkpoint()
      }
    }
    // ids become frequency ranks: 0 = most frequent, ties by token (code units)
    let order = Array(0..<words.count).sorted { x, y in
      counts[x] != counts[y] ? counts[x] > counts[y] : jsLess(words[x], words[y])
    }
    var rank = [UInt32](repeating: 0, count: words.count)
    for (r, prov) in order.enumerated() { rank[prov] = UInt32(r) }
    let ids = provisional.map { rank[Int($0)].littleEndian }
    try ids.withUnsafeBytes { try Data($0).write(to: tmp(f.ids)) }
    try pidx.map(\.littleEndian).withUnsafeBytes { try Data($0).write(to: tmp(f.pidx)) }
    var vocab = order.enumerated().map { "\($0.offset)\t\(words[$0.element])\t\(counts[$0.element])" }.joined(separator: "\n")
    if !order.isEmpty { vocab += "\n" }
    try Data(vocab.utf8).write(to: tmp(f.vocab))
    let manifest: [(String, JSONValue)] = [
      ("lang", .string(lang)), ("version", .string(version)), ("data_version", .int(dv)), ("signature", .string(signature)),
      ("tokenizer", .string(Tokenizer.version)), ("segmenter", "seg-1"), ("quality_version", .string(try c.metaValue("quality_version") ?? "0")),
      ("byte_order", "LE"), ("passages", .int(passages)), ("tokens", .int(total)), ("types", .int(words.count)),
      ("run_id", runID.map { .int($0) } ?? .null), ("built_at", .string(StoreClock.isoNow())),
    ]
    // JSON.stringify(manifest, null, 1): one key per line, indented by one space, insertion order
    let body = manifest.map { " \(jsonString($0.0)): \(CanonicalJSON.string($0.1))" }.joined(separator: ",\n")
    try Data("{\n\(body)\n}".utf8).write(to: tmp(f.manifest))
    let fm = FileManager.default
    for (from, to) in [(tmp(f.ids), f.ids), (tmp(f.pidx), f.pidx), (tmp(f.vocab), f.vocab), (tmp(f.manifest), f.manifest)] {
      _ = try fm.replaceItemAt(to, withItemAt: from)
    }
    cache.withLock { $0["\(dir.path)|\(lang)"] = nil }
    return (lang, passages, total, words.count)
  }
}
