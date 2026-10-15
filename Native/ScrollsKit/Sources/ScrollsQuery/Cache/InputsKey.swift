// OWNER: N3
// Port of cube.mjs `corpusInputsKey`: the fingerprint of what a corpus artifact reads — the scope's collections and their
// attributes, their import batches by status and the passage quality version. Documents are only ever written, reverted
// or rolled back through an import batch, so the batches say when the documents change; no document table is read. A
// materialization, an annotation or another corpus's import keeps the artifact.

import ScrollsCore
import ScrollsStore

/// Fingerprints of a corpus's artifact inputs.
public enum InputsKey {
  /// Which collections an artifact reads.
  public enum Scope: String, Sendable {
    case all, rate, endpoints, cells, labels
  }

  /// `corpusInputsKey(db, corpusId, {scope})`: 16 hex characters.
  public static func corpus(_ c: Connection, _ corpusId: Int64, scope: Scope = .all) throws -> String {
    let colls = try c.prepared(InputsKeySQL.collections[scope]!)
    try colls.bind([.int(corpusId)])
    var ids: [Int64] = []
    let collRows: [OJ] = try colls.all { r in
      ids.append(r.int(0))
      return OJ.obj([("id", .int(r.int(0))), ("slug", .str(r.text(1))), ("domain", .str(r.text(2))), ("modality", .str(r.text(3))),
                     ("unit", .str(r.text(4))), ("coverage_gate", .int(r.intOrNil(5))), ("sampling", .str(r.text(6))),
                     ("rate_eligible", .int(r.int(7)))])
    }
    let b = try c.prepared(InputsKeySQL.batches)
    try b.bind([.text(SQLJSON.ints(ids))])
    let batchRows: [OJ] = try b.all { r in
      OJ.obj([("status", .str(r.text(0))), ("n", .int(r.int(1))), ("m", .int(r.intOrNil(2)))])
    }
    let quality = try Meta.get(c, "quality_version") ?? "0"
    return IDs.shortHash(OJ.arr([.str(scope.rawValue), .arr(collRows), .arr(batchRows), .str(quality)]).stringify(), length: 16)
  }
}

/// Statements of the inputs keys.
public enum InputsKeySQL: SQLCatalog {
  static let columns = "id, slug, domain, modality, unit, coverage_gate, sampling, rate_eligible"
  static let conditions: [InputsKey.Scope: String] = [
    .all: "1", .rate: "rate_eligible = 1", .endpoints: "rate_eligible = 0 AND sampling = 'relation_endpoints'",
    .cells: "sampling = 'top_cited_per_cell'", .labels: "modality <> 'lexical'",
  ]
  static let collections: [InputsKey.Scope: SQL] = Dictionary(uniqueKeysWithValues: conditions.map { scope, cond in
    (scope, SQL("q.inputs.collections.\(scope.rawValue)",
                "SELECT \(columns) FROM collection WHERE corpus_id = ? AND \(cond) ORDER BY id",
                scan: .scanOK(reason: "collections (tens)")))
  })
  static let batches = SQL("q.inputs.batches", """
    SELECT status, count(*) AS n, max(id) AS m FROM import_batch WHERE collection_id IN (SELECT value FROM json_each(?))
      GROUP BY status ORDER BY status
    """, scan: .scanOK(reason: "import batches (hundreds)"))

  public static var all: [SQL] { collections.values.sorted { $0.id < $1.id } + [batches] }
}
