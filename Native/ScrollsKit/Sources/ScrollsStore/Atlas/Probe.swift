// OWNER: N0
// The SQLite and text-parity probe (IOS-SPEC §1.4, §3.8): run at first launch, in `-selftest probe`, and on the Mac in
// tests. It re-checks on this device what the port was measured against — the SQLite version and compile options,
// FTS5 tokenizing the reference's folded token string into exactly the generated tokenizer's tokens (and the terms the
// Mac's SQLite 3.54.0 makes of them), rtree_i32 with BCE day numbers, JSON1, contentless_delete, the Final_Sigma fold,
// and the sentence boundaries of bundled books. A failed check refuses the atlas (`StoreFailures.probeRefused`);
// nothing is changed. Fonts, NaturalLanguage availability and background-task identifiers are added by the app.

import CryptoKit
import Foundation
import ScrollsCore
import SQLite3

/// One probe row.
public struct ProbeCheck: Codable, Sendable, Equatable {
  public enum Status: String, Codable, Sendable { case pass = "PASS", fail = "FAIL", warn = "WARN", skip = "SKIP" }
  public let name: String
  public let status: Status
  public let detail: String
  public init(name: String, status: Status, detail: String) {
    self.name = name
    self.status = status
    self.detail = detail
  }
}

/// What the probe found.
public struct ProbeReport: Codable, Sendable, Equatable {
  public var checks: [ProbeCheck]
  public var sqliteVersion: String
  public var sqliteVersionNumber: Int
  public var compileOptions: [String]
  public var icuVersion: String
  public var availableMemoryBytes: Int
  public var physFootprintBytes: UInt64
  /// The largest total of 256 MB file mappings that succeeded (only with `measureVM`).
  public var largestMappingBytes: Int?
  public var at: String
  /// No check failed (warnings and skips do not refuse the atlas).
  public var passed: Bool { !checks.contains { $0.status == .fail } }
  /// The failed checks, for the refusal message.
  public var failures: String { checks.filter { $0.status == .fail }.map { "\($0.name): \($0.detail)" }.joined(separator: "; ") }
}

/// The device probe.
public enum Probe {
  /// The parity string and what the reference's tokenizer and the Mac's SQLite 3.54.0 make of it (measured
  /// 2026-10-10 with Node 26.10.0 tokenize.mjs and /usr/bin/sqlite3 3.54.0).
  static let parityText = "Café ΟΔΟΣ ΣΑΣ naïve Ångström 1,234 x² ◉ 🎬 शून्य शून्यता ગુજરાતી શૂન્ય 北京 Zoë’s co-op ℃ ﬁ İstanbul"
  static let parityTokens = ["café", "οδος", "σας", "naïve", "ångström", "1", "234", "x²", "◉", "🎬", "शून्य", "शून्यता",
                             "ગુજરાતી", "શૂન્ય", "北京", "zoë", "s", "co", "op", "℃", "ﬁ", "i̇stanbul"]
  static let parityFTSTerms = ["cafe", "οδοσ", "σασ", "naive", "angstrom", "1", "234", "x²", "◉", "🎬", "शून्य", "शून्यता",
                               "ગુજરાતી", "શૂન્ય", "北京", "zoe", "s", "co", "op", "℃", "ﬁ", "istanbul"]
  static let minimumVersion: Int32 = 3_046_000

  /// Runs every check. `sampleTexts` is a folder of `<name>.txt` with `<name>.sentences.sha256` (the sha256 of the
  /// canonical JSON array of `SentenceBreaker.starts`, made on the Mac); `measureVM` maps a sparse file in 256 MB
  /// windows until failure (≤ 6 GiB; `-selftest probe` only).
  public static func run(sampleTexts: URL?) -> ProbeReport { run(sampleTexts: sampleTexts, measureVM: false) }

  public static func run(sampleTexts: URL?, measureVM: Bool) -> ProbeReport {
    var checks: [ProbeCheck] = []
    let version = Int(sqlite3_libversion_number())
    checks.append(ProbeCheck(name: "sqlite.version", status: version >= Int(minimumVersion) ? .pass : .fail,
                             detail: "\(String(cString: sqlite3_libversion())) (need ≥ 3.46.0)"))
    var options: [String] = []
    var i: Int32 = 0
    while let o = sqlite3_compileoption_get(i) {
      options.append(String(cString: o))
      i += 1
    }
    checks.append(compileOptionsCheck(options))
    do {
      let c = try Connection(path: ":memory:", mode: .readWrite, profile: .device)
      checks.append(ftsParity(c))
      checks.append(rtree(c))
      checks.append(json1(c))
      checks.append(contentlessDelete(c))
    } catch {
      checks.append(ProbeCheck(name: "sqlite.open", status: .fail, detail: "\(error)"))
    }
    let folded = Fold.fold("ΟΔΟΣ ΣΑΣ")
    checks.append(ProbeCheck(name: "fold.final_sigma", status: folded == "οδος σας" ? .pass : .fail,
                             detail: "ΟΔΟΣ ΣΑΣ → \(folded) (want οδος σας)"))
    checks.append(contentsOf: sentenceChecks(sampleTexts))
    var largest: Int? = nil
    if measureVM {
      largest = largestMapping()
      checks.append(ProbeCheck(name: "vm.largest_mapping", status: (largest ?? 0) >= MappedFileRegistry.budgetBytes ? .pass : .warn,
                               detail: "\((largest ?? 0) >> 20) MB mapped at once (budget \(MappedFileRegistry.budgetBytes >> 20) MB)"))
    }
    return ProbeReport(checks: checks, sqliteVersion: String(cString: sqlite3_libversion()), sqliteVersionNumber: version,
                       compileOptions: options, icuVersion: StoreVersions.icu, availableMemoryBytes: MemoryBudget.availableBytes(),
                       physFootprintBytes: MemoryBudget.physFootprint(), largestMappingBytes: largest, at: StoreClock.isoNow())
  }

  static func compileOptionsCheck(_ options: [String]) -> ProbeCheck {
    let threadsafe = options.first { $0.hasPrefix("THREADSAFE=") }.map { String($0.dropFirst(11)) } ?? "?"
    var problems: [String] = []
    if threadsafe == "0" { problems.append("THREADSAFE=0") }
    let mmap = options.first { $0.hasPrefix("MAX_MMAP_SIZE=") }.flatMap { Int($0.dropFirst(14)) }
    let detail = "THREADSAFE=\(threadsafe), MAX_MMAP_SIZE=\(mmap.map(String.init) ?? "default")"
      + (options.contains("OMIT_LOAD_EXTENSION") ? ", OMIT_LOAD_EXTENSION" : "")
    if !problems.isEmpty { return ProbeCheck(name: "sqlite.compile_options", status: .fail, detail: problems.joined(separator: ", ")) }
    if let mmap, mmap < 256 << 20 {
      return ProbeCheck(name: "sqlite.compile_options", status: .warn, detail: detail + " (readers get less mmap than planned)")
    }
    return ProbeCheck(name: "sqlite.compile_options", status: .pass, detail: detail)
  }

  /// The generated tokenizer and FTS5 agree token for token on the parity string.
  static func ftsParity(_ c: Connection) -> ProbeCheck {
    let name = "fts5.tokenizer_parity"
    let swiftTokens = Tokenizer.tokenize(parityText).map(\.norm)
    guard swiftTokens == parityTokens else {
      return ProbeCheck(name: name, status: .fail, detail: "the generated tokenizer gives \(swiftTokens), the reference \(parityTokens)")
    }
    do {
      try c.exec(ProbeSQL.createFTS)
      let ins = try c.prepared(dynamic: ProbeSQL.insertFTS)
      try ins.bind(.text(swiftTokens.joined(separator: " ")))
      try ins.run()
      let rows = try c.prepared(dynamic: ProbeSQL.vocabInstances).all { ($0.text(0), Int($0.int(1))) }
      try c.exec(ProbeSQL.dropFTS)
      let offsetsOK = rows.enumerated().allSatisfy { $0.offset == $0.element.1 }
      let terms = rows.map(\.0)
      if rows.count != swiftTokens.count || !offsetsOK {
        return ProbeCheck(name: name, status: .fail, detail: "FTS5 makes \(rows.count) tokens of the \(swiftTokens.count) the tokenizer makes")
      }
      if terms != parityFTSTerms {
        return ProbeCheck(name: name, status: .fail, detail: "FTS5 terms \(terms) differ from the Mac's \(parityFTSTerms)")
      }
      return ProbeCheck(name: name, status: .pass, detail: "\(rows.count) tokens, FTS token i = tokenizer token i")
    } catch {
      return ProbeCheck(name: name, status: .fail, detail: "\(error)")
    }
  }

  /// rtree_i32 stores and finds BCE day numbers (days before 1970 back to the third millennium BCE).
  static func rtree(_ c: Connection) -> ProbeCheck {
    do {
      try c.exec(ProbeSQL.createRTree)
      let ids = try c.prepared(dynamic: ProbeSQL.rtreeQuery)
        .all { $0.int(0) }
      try c.exec(ProbeSQL.dropRTree)
      return ProbeCheck(name: "sqlite.rtree_i32", status: ids == [1, 2] ? .pass : .fail, detail: "BCE ranges found: \(ids) (want [1, 2])")
    } catch {
      return ProbeCheck(name: "sqlite.rtree_i32", status: .fail, detail: "\(error)")
    }
  }

  static func json1(_ c: Connection) -> ProbeCheck {
    do {
      let r = try c.prepared(dynamic: ProbeSQL.json1)
        .first { ($0.int(0), $0.text(1)) }
      let ok = r?.0 == 1 && r?.1 == "x"
      return ProbeCheck(name: "sqlite.json1", status: ok ? .pass : .fail, detail: ok ? "json_valid, json_extract" : "unexpected \(String(describing: r))")
    } catch {
      return ProbeCheck(name: "sqlite.json1", status: .fail, detail: "\(error)")
    }
  }

  static func contentlessDelete(_ c: Connection) -> ProbeCheck {
    do {
      try c.exec(ProbeSQL.createContentlessDelete)
      let n = try c.prepared(dynamic: ProbeSQL.contentlessMatch).first { $0.int(0) }
      try c.exec(ProbeSQL.dropContentlessDelete)
      return ProbeCheck(name: "sqlite.fts5_contentless_delete", status: n == 1 ? .pass : .fail, detail: "rows matching after a delete: \(n ?? -1) (want 1)")
    } catch {
      return ProbeCheck(name: "sqlite.fts5_contentless_delete", status: .fail, detail: "\(error)")
    }
  }

  /// The hash of the sentence boundaries of each bundled sample equals the Mac's (iOS's ICU must agree too; DV-3).
  static func sentenceChecks(_ dir: URL?) -> [ProbeCheck] {
    guard let dir else { return [ProbeCheck(name: "sentences.samples", status: .skip, detail: "no sample texts given")] }
    let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".txt") }.sorted()
    if names.isEmpty { return [ProbeCheck(name: "sentences.samples", status: .skip, detail: "no .txt samples in \(dir.lastPathComponent)")] }
    return names.map { file in
      let base = String(file.dropLast(4))
      let name = "sentences.\(base)"
      guard let text = try? String(contentsOf: dir.appendingPathComponent(file), encoding: .utf8),
        let expected = try? String(contentsOf: dir.appendingPathComponent(base + ".sentences.sha256"), encoding: .utf8)
      else { return ProbeCheck(name: name, status: .skip, detail: "missing text or .sentences.sha256") }
      let starts = SentenceBreaker.starts(text)
      let got = sentenceDigest(starts)
      let want = expected.trimmingCharacters(in: .whitespacesAndNewlines)
      return ProbeCheck(name: name, status: got == want ? .pass : .fail, detail: "\(starts.count) boundaries, sha256 \(got.prefix(12))…")
    }
  }

  /// sha256 of the canonical JSON array of sentence starts (what the Mac writes into `<name>.sentences.sha256`).
  public static func sentenceDigest(_ starts: [Int]) -> String {
    let text = CanonicalJSON.string(.array(starts.map { .number(Double($0)) }))
    return SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /// Maps a sparse file in 256 MB windows until a mapping fails (cap 6 GiB); returns the total that succeeded.
  static func largestMapping() -> Int {
    let window = 256 << 20, cap = 6 << 30
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-vm-probe-\(UUID().uuidString)")
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else { return 0 }
    defer { try? FileManager.default.removeItem(at: url) }
    let fd = open(url.path, O_RDWR)
    guard fd >= 0 else { return 0 }
    defer { close(fd) }
    guard ftruncate(fd, off_t(cap)) == 0 else { return 0 }
    var maps: [UnsafeMutableRawPointer] = []
    defer { for p in maps { munmap(p, window) } }
    var total = 0
    while total < cap {
      guard let p = mmap(nil, window, PROT_READ, MAP_PRIVATE, fd, off_t(total)), p != MAP_FAILED else { break }
      maps.append(p)
      total += window
    }
    return total
  }
}
