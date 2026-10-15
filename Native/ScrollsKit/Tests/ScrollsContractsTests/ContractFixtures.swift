// OWNER: N0
// Where the contract fixtures are: the reference's tests/contract, located from this file's path so `swift test`
// finds them in any build mirror (Tools/build.sh mirrors the reference beside Native/).

import Foundation
import ScrollsCore

enum ContractFixtures {
  /// …/Scrolls (the reference's root), five levels above this file.
  static let referenceRoot: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

  static let contractDir = referenceRoot.appendingPathComponent("tests/contract")

  struct Fixture {
    let file: String
    let json: JSONValue
  }

  static func load() throws -> [Fixture] {
    let names = try FileManager.default.contentsOfDirectory(atPath: contractDir.path).filter { $0.hasSuffix(".json") }.sorted()
    return try names.map { Fixture(file: $0, json: try JSONValue.parse(try Data(contentsOf: contractDir.appendingPathComponent($0)))) }
  }
}
