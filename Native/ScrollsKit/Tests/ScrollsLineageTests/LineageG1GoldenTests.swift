// OWNER: N5
// G1 lineage goldens (IOS-SPEC §2.2): `g1.winnow` and `g1.minhash`, compared exactly with the reference's winnow.mjs and
// minhash.mjs. Text cases go through the Swift tokenizer, fold and FNV ids end to end.

import Foundation
import ScrollsCore
@testable import ScrollsLineage
import Testing

@Suite("G1 lineage goldens")
struct LineageG1GoldenTests {
  /// Native/Scrolls/Resources/Probe (the app's bundled sample books), found from this file's path.
  static let probeDir: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Scrolls/Resources/Probe")

  @Test("g1.winnow: token ids, shingles, fingerprints, texts end to end, stable radix sort")
  func winnowFamily() throws {
    let report = LineageGolden.Report("g1.winnow")
    defer { report.write() }
    let cases = try LineageGolden.load("g1.winnow")
    for (i, c) in cases.enumerated() {
      let kind = c["kind"]?.stringValue ?? ""
      switch kind {
      case "tokenIds":
        let toks = c["tokens"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let got = Winnow.tokenIds(toks)
        report.check(got == c["ids"]?.u32s, "#\(i) tokenIds", expected: c["ids"] ?? .null, actual: u32json(got))
      case "shingles":
        let got = Winnow.shingleHashes(c["ids"]?.u32s ?? [], k: c["k"]?.int ?? 8)
        report.check(got == c["shingles"]?.u32s, "#\(i) shingles k=\(c["k"]?.int ?? 0)", expected: c["shingles"] ?? .null,
                     actual: u32json(got))
      case "winnow":
        let f = Winnow.winnow(c["ids"]?.u32s ?? [], k: c["k"]?.int ?? 8, w: c["w"]?.int ?? 6)
        report.check(f.hashes == c["hashes"]?.u32s && f.positions == c["positions"]?.u32s,
                     "#\(i) winnow n=\(c["ids"]?.arrayValue?.count ?? 0) k=\(c["k"]?.int ?? 0) w=\(c["w"]?.int ?? 0)",
                     expected: ["hashes": c["hashes"] ?? .null, "positions": c["positions"] ?? .null],
                     actual: ["hashes": u32json(f.hashes), "positions": u32json(f.positions)])
      case "winnow-digest":
        var rnd = Mulberry32(seed: UInt32(c["seed"]?.int ?? 0))
        let n = c["n"]?.int ?? 0, vocab = c["vocab"]?.numberValue ?? 1
        let ids = (0..<n).map { _ in IDs.fnv1a32("w\(Int((rnd.next() * vocab).rounded(.down)))") }
        let f = Winnow.winnow(ids)
        report.check(u32sha(ids) == c["ids_sha256"]?.stringValue, "#\(i) digest input")
        report.check(f.count == c["count"]?.int && u32sha(f.hashes) == c["hashes_sha256"]?.stringValue
                       && u32sha(f.positions) == c["positions_sha256"]?.stringValue, "#\(i) digest fingerprints",
                     expected: c["count"] ?? .null, actual: .number(Double(f.count)))
      case "text":
        let text = c["text"]?.stringValue ?? ""
        let ids = Winnow.tokenIds(Tokenizer.tokens(text).tokens)
        let f = Winnow.winnow(ids)
        let source = c["source"]?.stringValue ?? ""
        if let hashes = c["hashes"]?.u32s {
          report.check(f.hashes == hashes && f.positions == c["positions"]?.u32s, "#\(i) text \(source)",
                       expected: c["hashes"] ?? .null, actual: u32json(f.hashes))
        } else {
          report.check(ids.count == c["tokens"]?.int && f.count == c["count"]?.int
                         && u32sha(f.hashes) == c["hashes_sha256"]?.stringValue
                         && u32sha(f.positions) == c["positions_sha256"]?.stringValue, "#\(i) text \(source)",
                       expected: c["count"] ?? .null, actual: .number(Double(f.count)))
        }
      case "probe-book":
        // the books N0 bundles for the device probe; WinnowProbe.expected (the device self-test's constants) must equal
        // this golden case, and the Mac must reproduce it from the same files
        let name = c["name"]?.stringValue ?? ""
        let e = WinnowProbe.expected.first { $0.name == name }
        report.check(e.map { [$0.tokens, $0.count] == [c["tokens"]?.int, c["count"]?.int]
                       && $0.idsSHA256 == c["ids_sha256"]?.stringValue && $0.hashesSHA256 == c["hashes_sha256"]?.stringValue
                       && $0.positionsSHA256 == c["positions_sha256"]?.stringValue } ?? false,
                     "#\(i) WinnowProbe.expected[\(name)] = the golden")
        let book = LineageG1GoldenTests.probeDir.appendingPathComponent("\(name).txt")
        if let text = try? String(contentsOf: book, encoding: .utf8), let e {
          let r = WinnowProbe.check(e, text: text)
          report.check(r.passed, "#\(i) probe book \(name)", expected: c["count"] ?? .null, actual: .string(r.detail))
        } else {
          report.check(false, "#\(i) probe book \(name): \(book.path) is missing")
        }
      case "radix":
        var keys = c["keys"]?.u32s ?? []
        var vals = (0..<keys.count).map { UInt32($0) }
        Winnow.radixSortPairs(&keys, &vals)
        report.check(keys == c["sorted_keys"]?.u32s && vals == c["sorted_vals"]?.u32s, "#\(i) radix n=\(keys.count)")
      case "radix-digest":
        var rnd = Mulberry32(seed: UInt32(c["seed"]?.int ?? 0))
        let n = c["n"]?.int ?? 0, spread = c["spread"]?.numberValue ?? 1, mult = Int64(c["multiplier"]?.int ?? 1)
        var keys = (0..<n).map { _ in UInt32(truncatingIfNeeded: Int64((rnd.next() * spread).rounded(.down)) * mult) }
        var vals = (0..<n).map { UInt32($0) }
        report.check(u32sha(keys) == c["keys_sha256"]?.stringValue, "#\(i) radix digest input")
        Winnow.radixSortPairs(&keys, &vals)
        report.check(u32sha(keys) == c["sorted_keys_sha256"]?.stringValue
                       && u32sha(vals) == c["sorted_vals_sha256"]?.stringValue, "#\(i) radix digest")
      default:
        report.check(false, "#\(i) unknown kind \(kind)")
      }
    }
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.minhash: permutations, 3-shingles, Jaccard, signatures, band keys, units")
  func minhashFamily() throws {
    let report = LineageGolden.Report("g1.minhash")
    defer { report.write() }
    let cases = try LineageGolden.load("g1.minhash")
    for (i, c) in cases.enumerated() {
      let kind = c["kind"]?.stringValue ?? ""
      switch kind {
      case "permutations":
        let p = MinHash.permutations(perms: c["perms"]?.int ?? 0, seed: UInt32(c["seed"]?.int ?? 0))
        report.check(p.a == c["a"]?.u32s && p.b == c["b"]?.u32s, "#\(i) permutations \(c["perms"]?.int ?? 0)/\(c["seed"]?.int ?? 0)",
                     expected: c["b"] ?? .null, actual: u32json(p.b))
      case "shingles3":
        let got = MinHash.shingles3(c["ids"]?.u32s ?? [])
        report.check(got == c["shingles"]?.u32s, "#\(i) shingles3", expected: c["shingles"] ?? .null, actual: u32json(got))
      case "jaccard":
        let v = MinHash.jaccard(c["a"]?.u32s ?? [], c["b"]?.u32s ?? [])
        report.check(v.bitPattern == (c["value"]?.numberValue ?? .nan).bitPattern, "#\(i) jaccard",
                     expected: c["value"] ?? .null, actual: .number(v))
      case "minhash":
        let perms = c["perms"]?.int ?? 128, seed = UInt32(c["seed"]?.int ?? 42)
        let sig = MinHash.signature(c["shingles"]?.u32s ?? [], perms: perms, seed: seed)
        let bands = MinHash.lshBands(sig, bands: c["band_count"]?.int ?? MinHash.bands, rows: c["rows"]?.int ?? MinHash.rows)
        report.check(sig == c["signature"]?.u32s, "#\(i) signature", expected: c["signature"] ?? .null, actual: u32json(sig))
        report.check(bands == c["bands"]?.u32s, "#\(i) lsh bands", expected: c["bands"] ?? .null, actual: u32json(bands))
      case "minhash-strings":
        let sig = MinHash.signature(strings: c["strings"]?.arrayValue?.compactMap(\.stringValue) ?? [],
                                    perms: c["perms"]?.int ?? 128, seed: UInt32(c["seed"]?.int ?? 42))
        report.check(sig == c["signature"]?.u32s, "#\(i) string signature", expected: c["signature"] ?? .null,
                     actual: u32json(sig))
      case "bandKeysRange":
        let got = MinHash.bandKeysRange(c["shingles"]?.u32s ?? [], band0: c["band0"]?.int ?? 0, band1: c["band1"]?.int ?? 0)
        report.check(got == c["keys"]?.u32s, "#\(i) bandKeysRange", expected: c["keys"] ?? .null, actual: u32json(got))
      case "units":
        let text = c["text"]?.stringValue ?? ""
        let tok = Tokenizer.tokens(text)
        for r in c["results"]?.arrayValue ?? [] {
          let verse = r["verse"]?.boolValue ?? false, minTokens = r["min_tokens"]?.int ?? 6
          let units = MinHash.unitsOf(text, starts: tok.starts, ends: tok.ends, verse: verse, minTokens: minTokens)
          let got: JSONValue = .array(units.map { [.number(Double($0.t0)), .number(Double($0.t1))] })
          report.check(got == r["units"], "#\(i) units \(c["source"]?.stringValue ?? "") verse=\(verse) min=\(minTokens)",
                       expected: r["units"] ?? .null, actual: got)
        }
      default:
        report.check(false, "#\(i) unknown kind \(kind)")
      }
    }
    #expect(report.passed, "\(report.summary)")
  }
}
