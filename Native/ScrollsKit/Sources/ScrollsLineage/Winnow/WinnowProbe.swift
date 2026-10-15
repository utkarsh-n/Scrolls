// OWNER: N5
// Winnowing parity on the device (IOS-SPEC §2.7 device rows): the three sample books N0 bundles in the app
// (Scrolls/Resources/Probe) tokenized, folded, hashed and winnowed, compared with the reference's fingerprints. The
// expected digests are the `probe-book` cases of the golden family g1.winnow (reference 5a66c69 = ref-freeze-1's tree);
// ScrollsLineageTests checks these constants against the golden, so they cannot drift from it. On the phone this
// re-checks the tokenizer's class table, the NSString fold and FNV on iOS's own Foundation.

import CryptoKit
import Foundation
import ScrollsCore

/// The probe books' expected fingerprints and the check the device self-test runs.
public enum WinnowProbe {
  public struct Expected: Sendable, Equatable {
    public let name: String
    public let tokens: Int
    public let idsSHA256: String
    public let count: Int
    public let hashesSHA256: String
    public let positionsSHA256: String
  }

  /// From g1.winnow (`kind: probe-book`).
  public static let expected: [Expected] = [
    Expected(name: "en-third-class-in-indian-railways", tokens: 12_737,
             idsSHA256: "3c8066f42625b700ed678bd7e9cc09c24a0bf392814e31d6fac0fa56765385ee", count: 3_661,
             hashesSHA256: "c333bb96da903ab9b6fe0061f339384a52cee3f1b999499536a6ef80b66b28c9",
             positionsSHA256: "6a7de1b67657b02b5892aa610147bd574d3ec95f312ee10dcad5e1dec09bc775"),
    Expected(name: "hi-kavitavali", tokens: 18_978,
             idsSHA256: "9dc4e51626db046aa34add66fe059e31444f4073bc53852d3707974884e47479", count: 5_427,
             hashesSHA256: "8b073bcd113e7e0a6df0faa5e0433637ea3eef56e97c36b48b002bd25c5392b4",
             positionsSHA256: "c30a4cc1211ea55b086552e2c981515fc60deda404cb1bcea7ba9e91c6d26b29"),
    Expected(name: "gu-mameru", tokens: 4_956,
             idsSHA256: "ba53bc7c9bae5df26b27a2f5cd7e0c59348089636944f29c595049694b949917", count: 1_408,
             hashesSHA256: "496749eba4e8a5821217bcfd4bd4783fb7e15a432a16825454e02565d9dca21b",
             positionsSHA256: "f5fc1e05035982e12c5a5c5454460609a9b84450aa41de43437aaccbf29f223c"),
  ]

  /// One book's result.
  public struct Result: Sendable {
    public let name: String
    public let passed: Bool
    public let detail: String
    /// Tokenize + fold + hash + winnow, wall time.
    public let seconds: Double
    public let tokens: Int
  }

  /// Fingerprints one text and compares it with its expected digests.
  public static func check(_ e: Expected, text: String) -> Result {
    let t0 = ContinuousClock.now
    let ids = Winnow.tokenIds(Tokenizer.tokens(text).tokens)
    let f = Winnow.winnow(ids)
    let seconds = (ContinuousClock.now - t0) / .seconds(1)
    var problems: [String] = []
    if ids.count != e.tokens { problems.append("\(ids.count) tokens, expected \(e.tokens)") }
    if sha(ids) != e.idsSHA256 { problems.append("token ids differ") }
    if f.count != e.count { problems.append("\(f.count) fingerprints, expected \(e.count)") }
    if sha(f.hashes) != e.hashesSHA256 || sha(f.positions) != e.positionsSHA256 { problems.append("fingerprints differ") }
    let detail = problems.isEmpty
      ? "\(ids.count) tokens, \(f.count) fingerprints = the reference's"
      : problems.joined(separator: "; ")
    return Result(name: e.name, passed: problems.isEmpty, detail: detail, seconds: seconds, tokens: ids.count)
  }

  /// Checks every probe book found in `directory` (`<name>.txt`); a missing book is reported as such.
  public static func checkAll(in directory: URL) -> [Result] {
    expected.map { e in
      guard let text = try? String(contentsOf: directory.appendingPathComponent("\(e.name).txt"), encoding: .utf8) else {
        return Result(name: e.name, passed: false, detail: "the bundled book is missing", seconds: 0, tokens: 0)
      }
      return check(e, text: text)
    }
  }

  /// sha256 (hex) of the little-endian bytes of a u32 array.
  static func sha(_ a: [UInt32]) -> String {
    var le = a.map { $0.littleEndian }
    let data = le.withUnsafeMutableBytes { Data($0) }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
