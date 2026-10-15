// OWNER: N0
// IOS-SPEC §8.4.10 item 2: schema.sql is the reference's byte for byte (sha256), the DDL and the device profile
// execute, migration is idempotent and refuses foreign or newer databases, and the vocabulary seed equals the
// reference's seed rows (read from the Node-built mini database).

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsStore
import Testing

@Suite("Schema and migrations")
struct SchemaTests {
  @Test("schema.sql: the bundled copy, the frozen hash and server/db/schema.sql are the same bytes")
  func schemaHash() throws {
    let bundled = try StoreResources.data("schema.sql")
    #expect(StoreResources.sha256Hex(bundled) == StoreResources.schemaSHA256)
    let reference = Fixtures.scrollsRoot.appendingPathComponent("server/db/schema.sql")
    let data = try Data(contentsOf: reference)
    #expect(StoreResources.sha256Hex(data) == StoreResources.schemaSHA256, "server/db/schema.sql changed: re-copy it and update the hash")
    #expect(data == bundled)
  }

  @Test("the device profile only creates: no ALTER, no DROP, and every schema.sql object survives", arguments: [StoreProfile.device])
  func profileOnlyCreates(_ profile: StoreProfile) throws {
    let text = Fixtures.stripComments(try StoreResources.deviceProfileSQL()).uppercased()
    #expect(!text.contains("ALTER "))
    #expect(!text.contains("DROP "))
    let ref = try Connection(path: try Fixtures.atlas(.reference, seed: false), mode: .readOnly, profile: .reference)
    let dev = try Connection(path: try Fixtures.atlas(.device, seed: false), mode: .readOnly, profile: .device)
    let q = "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"
    let refObjects = try ref.prepared(dynamic: q).all { "\($0.text(0)) \($0.text(1)) \($0.text(2))" }
    let devObjects = Set(try dev.prepared(dynamic: q).all { "\($0.text(0)) \($0.text(1)) \($0.text(2))" })
    #expect(refObjects.allSatisfy(devObjects.contains), "a schema.sql object is missing or changed in the device profile")
    let added = try dev.prepared(dynamic: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all { $0.text(0) }
      .filter { name in !refObjects.contains { $0.hasPrefix("table \(name) ") } }
    #expect(added == ["id_counter", "journal_applied", "pack_install", "saved_view_portable", "text_chunk", "text_storage"])
  }

  @Test("a fresh atlas: meta rows, versions and the profile tag")
  func freshMeta() throws {
    let c = try Connection(path: try Fixtures.atlas(.device), mode: .readOnly, profile: .device)
    #expect(try Meta.get(c, "schema_version") == "1")
    #expect(try Meta.get(c, "data_version") == "0")
    #expect(try Meta.get(c, "tokenizer_version") == "u61m-1")
    #expect(try Meta.get(c, "segmenter_version") == "seg-1")
    #expect(try Meta.get(c, "profile") == "device-1")
    #expect(try Meta.get(c, "journal_applied_seq") == "0")
    let icu = try #require(try Meta.get(c, "icu_version"))
    #expect(icu.hasPrefix("macos") && icu.contains("/unicode"), "icu_version \(icu)")
    let created = try #require(try Meta.get(c, "created_at"))
    #expect(created.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"#, options: .regularExpression) != nil, "\(created)")
    let generation = try #require(try Meta.get(c, "generation"))
    #expect(UUID(uuidString: generation) != nil)
  }

  @Test("migrate is idempotent; a reference database opened as .device gains only the profile")
  func idempotent() throws {
    let path = try Fixtures.atlas(.reference)
    let c = try Connection(path: path, mode: .readWrite, profile: .reference)
    #expect(try Migrations.migrate(c) == MigrationResult(from: 1, to: 1, addedDeviceProfile: false))
    #expect(try !Migrations.hasDeviceProfile(c))
    c.close()
    let d = try Connection(path: path, mode: .readWrite, profile: .device)
    #expect(try Migrations.migrate(d) == MigrationResult(from: 1, to: 1, addedDeviceProfile: true))
    #expect(try Migrations.hasDeviceProfile(d))
    #expect(try Migrations.migrate(d) == MigrationResult(from: 1, to: 1, addedDeviceProfile: false))
  }

  @Test("migrate refuses a database with foreign tables (E_DB_FOREIGN) and a newer schema (E_SCHEMA_NEWER)")
  func refusals() throws {
    let foreign = try Fixtures.tempDir().appendingPathComponent("f.sqlite").path
    let f = try Connection(path: foreign, mode: .readWrite, profile: .device)
    try f.exec("CREATE TABLE other (x INTEGER)")
    let foreignError = #expect(throws: ScrollsError.self) { try Migrations.migrate(f) }
    #expect(foreignError?.code.rawValue == "E_DB_FOREIGN")
    let newer = try Connection(path: try Fixtures.atlas(.device), mode: .readWrite, profile: .device)
    try Meta.set(newer, "schema_version", "2")
    let newerError = #expect(throws: ScrollsError.self) { try Migrations.migrate(newer) }
    #expect(newerError?.code.rawValue == "E_SCHEMA_NEWER")
  }

  @Test("the vocabulary seed: corpus ids 1…n in the reference's order, idempotent; rows equal the Node-built mini database")
  func seed() throws {
    let path = try Fixtures.atlas(.device)
    let c = try Connection(path: path, mode: .readWrite, profile: .device)
    let corpora = try c.prepared(dynamic: "SELECT id, slug FROM corpus ORDER BY id").all { ($0.int(0), $0.text(1)) }
    #expect(corpora.map(\.0) == Array(1...Int64(Vocab.corpora.count)))
    #expect(corpora.map(\.1) == Vocab.corpora.map(\.slug))
    try c.transaction(.immediate) {
      let tx = WriteTx(connection: c, label: "reseed")
      try SeedVocab.seed(tx)
      try tx.ids.flush()
    }
    #expect(try c.prepared(dynamic: "SELECT count(*) FROM corpus").first { $0.int(0) } == Int64(Vocab.corpora.count))
    #expect(try c.prepared(dynamic: "SELECT next FROM id_counter WHERE tbl = 'corpus' AND slot = 0").first { $0.int(0) }
      == Int64(Vocab.corpora.count + 1))

    // the reference's own seed, as tests/helpers/tmpdata.mjs wrote it (corpus 'test' is the mini fixture's own)
    let mini = try Connection(path: Fixtures.miniDir.appendingPathComponent("mini.sqlite").path, mode: .readOnlyImmutable, profile: .reference)
    for (table, order) in [("rel_type", "code"), ("language_period", "lang")] {
      let q = "SELECT * FROM \(table) ORDER BY \(order)"
      let mine = try c.prepared(dynamic: q).all { r in (0..<r.count).map { r.value($0) } }
      let theirs = try mini.prepared(dynamic: q).all { r in (0..<r.count).map { r.value($0) } }
      #expect(mine == theirs, "\(table) differs from the reference's seed")
    }
    let dimQ = "SELECT key, label, type, options_json, builtin, created_by FROM dimension_def ORDER BY key"
    let dims = { (conn: Connection) in
      try conn.prepared(dynamic: dimQ).all { r -> String in
        let opts = r.isNull(3) ? "null" : CanonicalJSON.string(try JSONValue.parse(r.text(3)))
        return [r.text(0), r.text(1), r.text(2), opts, String(r.int(4)), r.text(5)].joined(separator: "|")
      }
    }
    #expect(try dims(c) == dims(mini))
    let corpusQ = "SELECT id, slug, name, kind, is_synthetic, description, license FROM corpus WHERE slug <> 'test' ORDER BY id"
    #expect(try c.prepared(dynamic: corpusQ).all { r in (0..<r.count).map { r.value($0) } }
      == mini.prepared(dynamic: corpusQ).all { r in (0..<r.count).map { r.value($0) } })
  }
}
