// OWNER: N0
// IOS-SPEC §3.3: every table of sqlite_master is classified; entity ids come from source slots or the local range and
// survive across transactions (id_counter) but not a rolled-back one; log ids are max + 1 in commit order; every id is
// < 2³¹ and a range that is used up refuses instead of overflowing into the next slot.

import Foundation
import ScrollsCore
@testable import ScrollsStore
import Testing

@Suite("Row ids")
struct RowIDPolicyTests {
  @Test("every table of schema.sql and the device profile is classified, and nothing else is")
  func everyTableClassified() throws {
    let c = try Connection(path: try Fixtures.atlas(.device), mode: .readOnly, profile: .device)
    let names = try LogicalDump.tableNames(c)
    let unclassified = names.filter { RowIDPolicy.classes[$0] == nil }
    #expect(unclassified.isEmpty, "unclassified tables: \(unclassified)")
    let stale = RowIDPolicy.classes.keys.filter { !names.contains($0) }
    #expect(stale.isEmpty, "classified tables that do not exist: \(stale)")
    #expect(names.count == RowIDPolicy.classes.count)
  }

  @Test("entity and log tables have an integer id their allocator can fill; keyed tables have none to allocate")
  func classesMatchStructure() throws {
    let c = try Connection(path: try Fixtures.atlas(.device), mode: .readOnly, profile: .device)
    for (table, cls) in RowIDPolicy.classes where cls == .entity || cls == .log {
      let cols = try c.prepared(dynamic: "PRAGMA table_info(\"\(table)\")").all { (name: $0.text(1), type: $0.text(2), pk: $0.int(5)) }
      let idColumn = table == "journal_applied" ? "seq" : "id"
      #expect(cols.contains { $0.name == idColumn && $0.type == "INTEGER" && $0.pk == 1 }, "\(table) has no INTEGER PRIMARY KEY \(idColumn)")
    }
  }

  @Test("slot and local ranges: slot × 10⁸ + n, 1.5 × 10⁹ + n; counters persist across transactions and roll back with them")
  func slotsAndLocal() async throws {
    let (_, writer, _) = try Fixtures.store()
    let first = try await writer.write("ids") { tx in
      [try tx.ids.next("passage", .slot(.cipherText)), try tx.ids.next("passage", .slot(.cipherText)),
       try tx.ids.next("passage", .local), try tx.ids.next("document", .slot(.stemmOpenAlex))]
    }
    #expect(first == [300_000_001, 300_000_002, 1_500_000_001, 500_000_001])
    await #expect(throws: StoreError.self) {
      try await writer.write("rolled back") { tx in
        _ = try tx.ids.next("passage", .slot(.cipherText))
        throw StoreError.misuse("abort")
      }
    }
    let second = try await writer.write("ids again") { tx in try tx.ids.next("passage", .slot(.cipherText)) }
    #expect(second == 300_000_003)
    // the corpus seed took slot-0 ids 1…n
    let corpus = try await writer.write("corpus") { tx in try tx.ids.next("corpus", .slot(.base)) }
    #expect(corpus == Int64(Vocab.corpora.count + 1))
  }

  @Test("a counter that meets existing rows (a converted reference database) starts above them")
  func counterStartsAboveRows() async throws {
    let (_, writer, _) = try Fixtures.store()
    let next = try await writer.write("rows") { tx in
      try tx.connection.exec("INSERT INTO hypothesis_group (id, target_type, target_ref, question, created_by, created_at) VALUES (1500000041, 'document', '1', 'q', 'human:u', 't')")
      return try tx.ids.next("hypothesis_group", .local)
    }
    #expect(next == 1_500_000_042)
  }

  @Test("an exhausted range refuses: no id spills into the next slot or past 2³¹")
  func exhausted() async throws {
    let (_, writer, _) = try Fixtures.store()
    try await writer.write("set counters") { tx in
      try tx.connection.exec("INSERT INTO id_counter (tbl, slot, next) VALUES ('passage', 3, 399999999), ('passage', 15, 2147483647)")
    }
    let last = try await writer.write("last") { tx in try tx.ids.next("passage", .slot(.cipherText)) }
    #expect(last == 399_999_999)
    await #expect(throws: StoreError.self) { try await writer.write("over") { tx in try tx.ids.next("passage", .slot(.cipherText)) } }
    let top = try await writer.write("top") { tx in try tx.ids.next("passage", .local) }
    #expect(top == Int64(Int32.max))
    await #expect(throws: StoreError.self) { try await writer.write("past 2^31") { tx in try tx.ids.next("passage", .local) } }
  }

  @Test("log tables: max + 1, also within one transaction; non-entity tables refuse entity ids")
  func logIDs() async throws {
    let (_, writer, _) = try Fixtures.store()
    let ids = try await writer.write("log") { tx -> [Int64] in
      try tx.connection.exec("INSERT INTO job (id, type, params_json, writes, status, created_at) VALUES (41, 'x', '{}', 0, 'queued', 't')")
      let a = try tx.ids.nextLog("job")
      let b = try tx.ids.nextLog("job")
      return [a, b, try tx.ids.nextLog("journal_applied")]
    }
    #expect(ids == [42, 43, 1])
    await #expect(throws: StoreError.self) { try await writer.write("x") { tx in try tx.ids.next("job", .local) } }
    await #expect(throws: StoreError.self) { try await writer.write("x") { tx in try tx.ids.nextLog("passage") } }
    await #expect(throws: StoreError.self) { try await writer.write("x") { tx in try tx.ids.next("doc_tag", .local) } }
  }

  @Test("a reference database (no profile) allocates max + 1")
  func referenceProfile() async throws {
    let path = try Fixtures.atlas(.reference)
    let writer = try Writer(path: path, profile: .reference)
    let id = try await writer.write("ref") { tx in try tx.ids.next("corpus", .slot(.cipherMeta)) }
    #expect(id == Int64(Vocab.corpora.count + 1))
  }

  @Test("SourceSlot is 0…14 and codes as a bare number")
  func slotCoding() throws {
    let data = try JSONEncoder().encode([SourceSlot.cipherText])
    #expect(String(decoding: data, as: UTF8.self) == "[3]")
    #expect(throws: DecodingError.self) { try JSONDecoder().decode([SourceSlot].self, from: Data("[15]".utf8)) }
    #expect(RowIDPolicy.range(.slot(SourceSlot(rawValue: 14))).last < RowIDPolicy.localBase)
  }
}
