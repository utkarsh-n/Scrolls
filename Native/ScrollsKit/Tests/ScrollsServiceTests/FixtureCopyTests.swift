// OWNER: N0
// The fixtures MockAtlas bundles are byte-equal copies of the reference's tests/contract (IOS-SPEC §8.4.10), and the
// bundle MockAtlas reads at run time holds the same files.

import CryptoKit
import Foundation
import Testing

enum ServiceFixtures {
  /// …/Scrolls (the reference's root), five levels above this file.
  static let referenceRoot: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
  static let contractDir = referenceRoot.appendingPathComponent("tests/contract")
  static let bundledDir = referenceRoot.appendingPathComponent("Native/ScrollsKit/Sources/ScrollsService/Resources/contract-fixtures")

  static func digests(_ dir: URL) throws -> [String: String] {
    var out: [String: String] = [:]
    for name in try FileManager.default.contentsOfDirectory(atPath: dir.path) where name.hasSuffix(".json") {
      let data = try Data(contentsOf: dir.appendingPathComponent(name))
      out[name] = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    return out
  }
}

@Suite("Bundled contract fixtures")
struct FixtureCopyTests {
  @Test("ScrollsService/Resources/contract-fixtures is a byte-equal copy of tests/contract (65 files)")
  func byteEqual() throws {
    let reference = try ServiceFixtures.digests(ServiceFixtures.contractDir)
    let bundled = try ServiceFixtures.digests(ServiceFixtures.bundledDir)
    #expect(reference.count == 65)
    #expect(Set(bundled.keys) == Set(reference.keys), "the same file names")
    for (name, sha) in reference { #expect(bundled[name] == sha, "\(name) differs from tests/contract") }
  }
}
