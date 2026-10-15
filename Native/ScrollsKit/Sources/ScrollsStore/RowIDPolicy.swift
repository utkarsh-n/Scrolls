// OWNER: N0
// Row ids (IOS-SPEC §3.3). Every table of schema.sql and the device profile is classified; RowIDPolicyTests parses
// sqlite_master and fails on any table missing here. Entity rows written by a source load take ids from that source's
// slot (`slot × 10⁸ + n`), every other writer takes the local range (`1.5 × 10⁹ + n`); log tables keep commit order
// (`max + 1`). Every id is < 2³¹, so the cube's Int32 columns and the winnow u32 packing stay valid.
//
// Classification by structure (a deviation from the spec's prose list, which calls document_field, document_alias,
// doc_tag, etymon and collocation "entity"): those five have no integer id of their own (WITHOUT ROWID or a text key),
// so nothing can be allocated for them; they are `keyed`. Virtual tables are keyed by the row they index.

import Foundation

/// How a table's row ids are made.
public enum TableClass: Sendable, Equatable {
  /// Integer ids from a source slot or the local range.
  case entity
  /// `max + 1` at insert: id order is commit order (as-saved cutoffs, "a newer run exists").
  case log
  /// No ids of their own: keyed by another row's id or a natural key.
  case keyed
  /// Not used on the phone, or rebuilt.
  case cache
}

/// A source's id range: 0 base (seeded vocab, corpora, the demo), 1–6 the Cipher and STEMM sources, 7–14 future packs.
public struct SourceSlot: RawRepresentable, Sendable, Hashable, Codable {
  public let rawValue: Int
  public init(rawValue: Int) {
    precondition((0...14).contains(rawValue), "source slots are 0…14")
    self.rawValue = rawValue
  }
  public static let base = SourceSlot(rawValue: 0), cipherMeta = SourceSlot(rawValue: 1),
    cipherRelations = SourceSlot(rawValue: 2), cipherText = SourceSlot(rawValue: 3),
    stemmGutenberg = SourceSlot(rawValue: 4), stemmOpenAlex = SourceSlot(rawValue: 5),
    stemmWiktionary = SourceSlot(rawValue: 6)

  public init(from decoder: any Decoder) throws {
    let n = try decoder.singleValueContainer().decode(Int.self)
    guard (0...14).contains(n) else {
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "source slot \(n) is not 0…14"))
    }
    rawValue = n
  }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(rawValue)
  }
}

/// Where an entity id comes from.
public enum IDScope: Sendable, Equatable {
  case slot(SourceSlot)
  case local
}

/// The classification of every table, and the id arithmetic.
public enum RowIDPolicy {
  public static let slotWidth: Int64 = 100_000_000
  public static let localBase: Int64 = 1_500_000_000
  public static let ceiling: Int64 = Int64(Int32.max)

  /// The tables whose cutoffs a saved view records (IOS-SPEC §6.4); `journal_applied.max_ids_json` holds their max ids.
  public static let cutoffTables = ["import_batch", "relationship_revision", "annotation_revision"]

  /// Every table of schema.sql and device-profile.sql (shadow tables of virtual tables excluded).
  public static let classes: [String: TableClass] = [
    // 1. provenance spine
    "meta": .keyed, "corpus": .entity, "source_adapter": .keyed, "collection": .entity, "original_file": .keyed,
    "import_batch": .log, "import_issue": .entity,
    // 2. documents & text
    "document": .entity, "document_text": .keyed, "document_field": .keyed, "document_alias": .keyed, "doc_tag": .keyed,
    "doc_minhash": .keyed,
    // 3. time
    "date_assertion": .entity, "date_rtree": .keyed, "language_period": .keyed, "doc_bin": .keyed, "doc_tokens": .keyed,
    // 4. passages & search (passage_fts rowid = passage.id; the vocab tables are views of passage_fts)
    "passage": .entity, "passage_fts": .keyed, "passage_vocab_row": .keyed, "passage_vocab_inst": .keyed,
    "label_tri": .keyed,
    // 5. expressions, occurrences
    "expression": .entity, "expression_variant": .entity, "expression_state": .keyed, "occurrence": .entity,
    "expr_doc": .keyed,
    // 6. etymology
    "etymon": .keyed, "etymon_parent": .keyed, "etymon_member": .keyed,
    // 7. analysis
    "analysis_run": .log, "time_window": .entity, "collocation": .keyed, "vector_space": .entity,
    "space_alignment": .entity, "sense_cluster": .entity, "cluster_member": .keyed, "cluster_share": .keyed,
    "cluster_transition": .entity, "drift_result": .entity, "compare_log": .log,
    // 8. relationships
    "rel_type": .keyed, "hypothesis_group": .entity, "relationship": .entity, "relationship_evidence": .entity,
    "relationship_revision": .log,
    // 9. interpretation (annotation_fts rowid = annotation_revision.id)
    "dimension_def": .keyed, "annotation": .entity, "annotation_revision": .log, "annotation_fts": .keyed,
    // 10. app state, jobs, caches
    "saved_view": .entity, "job": .log, "job_event": .log, "query_def": .cache, "tile_cache": .cache,
    "layout_cache": .cache, "theme_assoc": .keyed,
    // device profile
    "text_storage": .keyed, "text_chunk": .keyed, "id_counter": .keyed, "pack_install": .keyed,
    "journal_applied": .log, "saved_view_portable": .keyed,
  ]

  /// The first id below which a scope's ids never fall (exclusive), and the last id it may use (inclusive).
  public static func range(_ scope: IDScope) -> (base: Int64, last: Int64) {
    switch scope {
    case .slot(let s): (Int64(s.rawValue) * slotWidth, Int64(s.rawValue) * slotWidth + slotWidth - 1)
    case .local: (localBase, ceiling)
    }
  }

  /// The `id_counter.slot` value of a scope (the local range is counter slot 15, since 15 × 10⁸ = `localBase`).
  public static func counterSlot(_ scope: IDScope) -> Int {
    switch scope {
    case .slot(let s): s.rawValue
    case .local: 15
    }
  }

  /// Whether `name` is a shadow table of one of `virtualTables` (or an SQLite internal table).
  public static func isShadow(_ name: String, virtualTables: [String]) -> Bool {
    if name.hasPrefix("sqlite_") { return true }
    let suffixes = ["_data", "_idx", "_content", "_docsize", "_config", "_node", "_parent", "_rowid"]
    return virtualTables.contains { v in suffixes.contains { name == v + $0 } }
  }
}

/// Allocates ids inside one write transaction. Entity counters live in `id_counter` (device profile) and are written
/// back at commit; log ids are `max(id) + 1`. On a reference database (no profile) entity ids are `max + 1` too.
public final class RowIDAllocator {
  private struct Key: Hashable {
    let table: String
    let slot: Int
  }
  private let connection: Connection
  private var next: [Key: Int64] = [:]
  private var dirty: Set<Key> = []
  private var logNext: [String: Int64] = [:]

  init(connection: Connection) { self.connection = connection }

  /// The next id of entity `table` in `scope`. Throws when the scope's range or 2³¹ is exhausted.
  public func next(_ table: String, _ scope: IDScope) throws -> Int64 {
    guard RowIDPolicy.classes[table] == .entity else {
      throw StoreError.misuse("\(table) is not an entity table (\(String(describing: RowIDPolicy.classes[table])))")
    }
    let key = Key(table: table, slot: connection.profile == .device ? RowIDPolicy.counterSlot(scope) : -1)
    let (base, last) = connection.profile == .device ? RowIDPolicy.range(scope) : (0, RowIDPolicy.ceiling)
    let id: Int64
    if let n = next[key] {
      id = n
    } else if connection.profile == .device,
      let stored = try connection.prepared(StoreSQL.readIDCounter).bindingFirst([.text(table), .int(Int64(key.slot))], { $0.int(0) })
    {
      id = stored
    } else {
      let m = try connection.prepared(dynamic: "SELECT max(id) FROM \"\(table)\" WHERE id > ? AND id <= ?")  // lint: sql-ok (table name from RowIDPolicy.classes)
        .bindingFirst([.int(base), .int(last)]) { $0.isNull(0) ? nil : $0.int(0) } ?? nil
      id = (m ?? base) + 1
    }
    guard id > base, id <= last, id <= RowIDPolicy.ceiling else {
      throw StoreError.misuse("id range of \(table) in \(scope) is exhausted (next \(id), last \(last))")
    }
    next[key] = id + 1
    if connection.profile == .device { dirty.insert(key) }
    return id
  }

  /// The next id of log `table`: above every committed row and every id handed out in this transaction.
  public func nextLog(_ table: String) throws -> Int64 {
    guard RowIDPolicy.classes[table] == .log else { throw StoreError.misuse("\(table) is not a log table") }
    let column = table == "journal_applied" ? "seq" : "id"
    let m = try connection.prepared(dynamic: "SELECT max(\(column)) FROM \"\(table)\"").first { $0.int(0) } ?? 0  // lint: sql-ok (table name from RowIDPolicy.classes)
    let id = max(m + 1, logNext[table] ?? 0)
    guard id <= RowIDPolicy.ceiling else { throw StoreError.misuse("\(table) ids reached 2³¹") }
    logNext[table] = id + 1
    return id
  }

  /// Writes the entity counters back (called by the writer before COMMIT).
  func flush() throws {
    guard !dirty.isEmpty else { return }
    let up = try connection.prepared(StoreSQL.upsertIDCounter)
    for key in dirty {
      try up.bind(.text(key.table), .int(Int64(key.slot)), .int(next[key]!))
      try up.run()
    }
    dirty.removeAll()
  }
}

extension Statement {
  /// Binds `values`, maps the first row (nil when there is none) and resets the statement.
  public func bindingFirst<T>(_ values: [SQLValue], _ map: (Row) throws -> T) throws -> T? {
    try bind(values)
    return try first(map)
  }
}
