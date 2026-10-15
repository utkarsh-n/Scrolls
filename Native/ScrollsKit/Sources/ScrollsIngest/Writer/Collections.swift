// OWNER: N1
// The shared helpers of store/document-writer.mjs for importers and adapters: originals (content-addressed under
// Notebook/originals/<sha[0:2]>/<sha256>, with the original_file row), collections (created once, is_synthetic copied
// from the corpus), import batches, ext-id resolution (aliases included) and the rollback of a whole batch (also used
// by recovery after an interrupted load). Collection and corpus ids are entity ids of the caller's scope; batch ids are
// log ids (commit order).

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A `collection` row (the columns the writers read).
public struct CollectionRow: Sendable, Equatable {
  public let id: Int64
  public let corpusID: Int64
  public let adapterID: String
  public let slug: String
  public let name: String
  public let isSynthetic: Bool
  public let exportTextAllowed: Bool
}

/// A `corpus` row.
public struct CorpusRow: Sendable, Equatable {
  public let id: Int64
  public let slug: String
  public let isSynthetic: Bool
}

/// An `import_batch` row.
public struct BatchRow: Sendable, Equatable {
  public let id: Int64
  public let collectionID: Int64?
  public let adapterID: String
  public let adapterVersion: String
  public let fileSha256: String?
  public let fileName: String?
  public let format: String
  public let mappingJSON: String
  public let optionsJSON: String
  public let summaryJSON: String?
  public let status: String
  public let jobID: Int64?
  public let createdAt: String
  public let committedAt: String?
}

/// `createBatch(db, spec)`.
public struct BatchSpec: Sendable {
  public var collectionID: Int64?
  public var adapterID: String?
  public var adapterVersion: String?
  public var format: String
  public var fileSha256: String?
  public var fileName: String?
  public var mappingJSON: String
  public var optionsJSON: String
  public var status: String
  public var jobID: Int64?

  public init(collectionID: Int64?, adapterID: String? = nil, adapterVersion: String? = nil, format: String = "adapter",
              fileSha256: String? = nil, fileName: String? = nil, mappingJSON: String = "{}", optionsJSON: String = "{}",
              status: String = "committing", jobID: Int64? = nil) {
    self.collectionID = collectionID
    self.adapterID = adapterID
    self.adapterVersion = adapterVersion
    self.format = format
    self.fileSha256 = fileSha256
    self.fileName = fileName
    self.mappingJSON = mappingJSON
    self.optionsJSON = optionsJSON
    self.status = status
    self.jobID = jobID
  }
}

/// `ensureCollection(db, spec)`.
public struct CollectionSpec: Sendable {
  public var slug: String
  public var name: String
  public var corpus: String
  public var adapterID: String
  public var domain: String
  public var modality: String
  public var unit: String
  public var sampling: String
  public var rateEligible: Bool?
  public var coverageGate: Int?
  public var exportTextAllowed: Bool?
  public var license: String?
  public var attribution: String?
  public var selectionNote: String?
  public var caveats: [String]
  public var sourceURI: String?
  public var retrievedAt: String?

  public init(slug: String, name: String, corpus: String, adapterID: String, domain: String, modality: String, unit: String,
              sampling: String, rateEligible: Bool? = nil, coverageGate: Int? = nil, exportTextAllowed: Bool? = nil,
              license: String? = nil, attribution: String? = nil, selectionNote: String? = nil, caveats: [String] = [],
              sourceURI: String? = nil, retrievedAt: String? = nil) {
    self.slug = slug
    self.name = name
    self.corpus = corpus
    self.adapterID = adapterID
    self.domain = domain
    self.modality = modality
    self.unit = unit
    self.sampling = sampling
    self.rateEligible = rateEligible
    self.coverageGate = coverageGate
    self.exportTextAllowed = exportTextAllowed
    self.license = license
    self.attribution = attribution
    self.selectionNote = selectionNote
    self.caveats = caveats
    self.sourceURI = sourceURI
    self.retrievedAt = retrievedAt
  }
}

/// Collections, batches, originals, ext ids and batch rollback.
public enum Collections {
  /// The file importers (`FILE_ADAPTERS` of adapters/registry.mjs).
  public static let fileFormats = ["txt", "md", "csv", "tsv", "json", "jsonl"]
  public static let fileAdapterVersion = "1.0.0"

  static func collectionRow(_ r: Row) -> CollectionRow {
    CollectionRow(id: r.int(0), corpusID: r.int(1), adapterID: r.text(2), slug: r.text(3), name: r.text(4), isSynthetic: r.int(5) != 0,
                  exportTextAllowed: r.int(6) != 0)
  }

  public static func collection(slug: String, on c: Connection) throws -> CollectionRow? {
    try c.prepared(IngestSQL.collectionBySlug).bindingFirst([.text(slug)], collectionRow)
  }

  public static func collection(id: Int64, on c: Connection) throws -> CollectionRow? {
    try c.prepared(IngestSQL.collectionByID).bindingFirst([.int(id)], collectionRow)
  }

  public static func corpus(slug: String, on c: Connection) throws -> CorpusRow? {
    try c.prepared(IngestSQL.corpusBySlug).bindingFirst([.text(slug)]) { CorpusRow(id: $0.int(0), slug: $0.text(1), isSynthetic: $0.int(2) != 0) }
  }

  public static func corpus(id: Int64, on c: Connection) throws -> CorpusRow? {
    try c.prepared(IngestSQL.corpusByID).bindingFirst([.int(id)]) { CorpusRow(id: $0.int(0), slug: $0.text(1), isSynthetic: $0.int(2) != 0) }
  }

  /// The slug of the corpus a collection belongs to, or nil when the collection does not exist.
  public static func corpusSlug(ofCollection slug: String, on c: Connection) throws -> String? {
    try c.prepared(IngestSQL.collectionCorpusSlug).bindingFirst([.text(slug)]) { $0.text(0) }
  }

  public static func batch(_ id: Int64, on c: Connection) throws -> BatchRow? {
    try c.prepared(IngestSQL.batchByID).bindingFirst([.int(id)]) { r in
      BatchRow(id: r.int(0), collectionID: r.intOrNil(1), adapterID: r.text(2), adapterVersion: r.text(3), fileSha256: r.textOrNil(4),
               fileName: r.textOrNil(5), format: r.text(6), mappingJSON: r.text(7), optionsJSON: r.text(8), summaryJSON: r.textOrNil(9),
               status: r.text(10), jobID: r.intOrNil(11), createdAt: r.text(12), committedAt: r.textOrNil(13))
    }
  }

  /// The file-importer source_adapter rows (what registerAdapters does for `FILE_ADAPTERS`).
  public static func registerFileAdapters(_ c: Connection) throws {
    let ins = try c.prepared(IngestSQL.insertAdapter)
    for f in fileFormats {
      try ins.bind(.text("file.\(f)"), .text(fileAdapterVersion), .text("\(f.uppercased()) file import"), .text("local-file"),
                   .text("as declared by the importer"), .text(""))
      try ins.run()
    }
  }

  /// `ensureCollection(db, spec)`: creates the collection when its slug is new (is_synthetic copied from the corpus).
  @discardableResult
  public static func ensureCollection(_ tx: WriteTx, _ spec: CollectionSpec, scope: IDScope) throws -> CollectionRow {
    let c = tx.connection
    if let existing = try collection(slug: spec.slug, on: c) { return existing }
    guard let corpus = try corpus(slug: spec.corpus, on: c) else {
      throw DocumentWriterError(code: "E_UNKNOWN_CORPUS", message: "ensureCollection: unknown corpus '\(spec.corpus)'")
    }
    func bit(_ v: Bool?, _ d: Int64) -> SQLValue { .int(v.map { $0 ? 1 : 0 } ?? d) }
    let id = try tx.ids.next("collection", scope)
    let ins = try c.prepared(IngestSQL.insertCollection)
    try ins.bind([
      .int(id), .int(corpus.id), .text(spec.adapterID), .text(spec.slug), .text(spec.name), .text(spec.domain), .text(spec.modality),
      .text(spec.unit), .text(spec.sampling), bit(spec.rateEligible, 1), .integer(spec.coverageGate), bit(spec.exportTextAllowed, 1),
      .int(corpus.isSynthetic ? 1 : 0), .string(spec.license), .string(spec.attribution), .string(spec.selectionNote),
      .text(JSText.stringify(JSONValue.array(spec.caveats.map(JSONValue.string)))), .string(spec.sourceURI), .string(spec.retrievedAt),
      .text(StoreClock.isoNow()),
    ])
    try ins.run()
    return try collection(slug: spec.slug, on: c)!
  }

  /// `createBatch(db, spec)`: an import_batch row (log id); returns its id.
  @discardableResult
  public static func createBatch(_ tx: WriteTx, _ spec: BatchSpec, now: Date = Date()) throws -> Int64 {
    let c = tx.connection
    var adapter = spec.adapterID
    if adapter == nil, let cid = spec.collectionID {
      guard let coll = try collection(id: cid, on: c) else {
        throw DocumentWriterError(code: "E_UNKNOWN_COLLECTION", message: "createBatch: unknown collection '\(cid)'")
      }
      adapter = coll.adapterID
    }
    guard let adapter else { throw DocumentWriterError(code: "E_UNKNOWN_COLLECTION", message: "createBatch: no collection and no adapter") }
    let version = try spec.adapterVersion ?? c.prepared(IngestSQL.adapterVersion).bindingFirst([.text(adapter)]) { $0.text(0) } ?? "0"
    let id = try tx.ids.nextLog("import_batch")
    let ins = try c.prepared(IngestSQL.insertBatch)
    try ins.bind([.int(id), .integer(spec.collectionID), .text(adapter), .text(version), .string(spec.fileSha256), .string(spec.fileName),
                  .text(spec.format), .text(spec.mappingJSON), .text(spec.optionsJSON), .text(spec.status), .integer(spec.jobID),
                  .text(StoreClock.iso(now))])
    try ins.run()
    return id
  }

  /// The relative path of a stored original (`originals/<sha[0:2]>/<sha256>`).
  public static func originalRelPath(_ sha: String) -> String { "originals/\(sha.prefix(2))/\(sha)" }

  /// sha256 (hex) of bytes.
  public static func sha256Hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

  /// `storeOriginal(db, bytes, meta)`: verbatim bytes under `<root>/originals/<sha[0:2]>/<sha256>` (immutable) and the
  /// original_file row; idempotent. Returns the sha256.
  @discardableResult
  public static func storeOriginal(_ tx: WriteTx, root: URL, bytes: Data, sourcePath: String?, encoding: String = "utf-8",
                                   hadBOM: Bool = false) throws -> String {
    let sha = sha256Hex(bytes)
    let rel = originalRelPath(sha)
    let abs = root.appendingPathComponent(rel)
    let fm = FileManager.default
    if !fm.fileExists(atPath: abs.path) {
      try fm.createDirectory(at: abs.deletingLastPathComponent(), withIntermediateDirectories: true)
      let tmp = abs.appendingPathExtension("\(ProcessInfo.processInfo.processIdentifier).tmp")
      try bytes.write(to: tmp)
      try fm.moveItem(at: tmp, to: abs)
    }
    try recordOriginal(tx.connection, sha: sha, relPath: rel, sourcePath: sourcePath, bytes: bytes.count, encoding: encoding, hadBOM: hadBOM)
    return sha
  }

  /// The original_file row of a file already stored (ON CONFLICT DO NOTHING).
  public static func recordOriginal(_ c: Connection, sha: String, relPath: String, sourcePath: String?, bytes: Int, encoding: String,
                                    hadBOM: Bool) throws {
    let ins = try c.prepared(IngestSQL.insertOriginal)
    try ins.bind(.text(sha), .text(relPath), .string(sourcePath), .int(Int64(bytes)), .text(encoding), .int(hadBOM ? 1 : 0),
                 .text(StoreClock.isoNow()))
    try ins.run()
  }

  /// `resolveExt(db, {collectionSlug, extId})`: the document of an ext_id (or alias) in a collection; with no collection,
  /// the unique match across collections (nil when absent or ambiguous).
  public static func resolveExt(collection slug: String?, extID: String, on c: Connection) throws -> Int64? {
    if let slug {
      if let d = try c.prepared(IngestSQL.extInCollection).bindingFirst([.text(slug), .text(extID)], { $0.int(0) }) { return d }
      return try c.prepared(IngestSQL.aliasInCollection).bindingFirst([.text(slug), .text(extID)]) { $0.int(0) }
    }
    let rows = try c.prepared(IngestSQL.extAnywhere).bindingAll([.text(extID), .text(extID)]) { $0.int(0) }
    return rows.count == 1 ? rows[0] : nil
  }

  /// `rollbackBatch(db, batchId, {status})`: deletes every row created for the documents of a batch and marks the batch
  /// with `status`. Relationships and annotations are written only by a successful finish, so an unfinished batch has none.
  /// Returns the documents removed.
  @discardableResult
  public static func rollbackBatch(_ tx: WriteTx, batch: Int64, status: String = "failed") throws -> Int {
    let c = tx.connection
    let ids = try c.prepared(IngestSQL.batchDocuments).bindingAll([.int(batch)]) { $0.int(0) }
    var i = 0
    while i < ids.count {
      let part = Array(ids[i..<min(i + 500, ids.count)])
      let chunk = JSText.stringify(JSONValue.array(part.map { JSONValue.number(Double($0)) }))
      let passages = try c.prepared(IngestSQL.passagesOfDocs).bindingAll([.text(chunk)]) { $0.int(0) }
      let pchunk = JSText.stringify(JSONValue.array(passages.map { JSONValue.number(Double($0)) }))
      func run(_ sql: SQL, _ values: SQLValue...) throws {
        let s = try c.prepared(sql)
        try s.bind(values)
        try s.run()
      }
      try run(IngestSQL.deleteFTSRows, .text(pchunk))
      try run(IngestSQL.deleteEvidenceOfPassages, .text(pchunk))
      try run(IngestSQL.deleteClusterMembers, .text(pchunk))
      try run(IngestSQL.deleteOccurrences, .text(pchunk))
      try run(IngestSQL.deleteExprDoc, .text(chunk))
      try run(IngestSQL.deleteRtreeOfDocs, .text(chunk), .text(pchunk))
      try run(IngestSQL.deleteDatesOfDocs, .text(chunk), .text(pchunk))
      try run(IngestSQL.deleteDocBinsOf, .text(chunk))
      try run(IngestSQL.deleteDocTokensOf, .text(chunk))
      try run(IngestSQL.deleteMinhashOf, .text(chunk))
      try run(IngestSQL.deleteTagsOf, .text(chunk))
      try run(IngestSQL.deleteAliasesOf, .text(chunk))
      try run(IngestSQL.deleteFieldsOf, .text(chunk))
      if c.profile == .device {
        try run(IngestSQL.deleteChunksOf, .text(chunk))
        try run(IngestSQL.deleteStorageOf, .text(chunk))
      }
      try run(IngestSQL.deleteTextOf, .text(chunk))
      try run(IngestSQL.deletePassagesOf, .text(chunk))
      let refs = JSText.stringify(JSONValue.array(part.map { JSONValue.string("document:\($0)") }))
      try run(IngestSQL.deleteLabelsOf, .text(refs))
      try run(IngestSQL.clearDupOf, .text(chunk))
      try run(IngestSQL.deleteDocsOf, .text(chunk))
      i += 500
    }
    let up = try c.prepared(IngestSQL.batchStatus)
    try up.bind(.text(status), .int(batch))
    try up.run()
    return ids.count
  }
}
