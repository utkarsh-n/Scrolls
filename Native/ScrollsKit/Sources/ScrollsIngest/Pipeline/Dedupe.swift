// OWNER: N1
// Port of server/ingest/dedupe.mjs (SPEC §5.4): duplicate detection for the preview, the dry run and the commit.
//  1. the same file already committed to the collection → E_DUP_FILE (the whole import is refused);
//  2. the same ext_id twice in one import → the second row is rejected, E_DUP_ID citing both lines; an ext_id that
//     already exists in the collection (an earlier import, reverted ones included: their rows are only soft-deleted)
//     → E_DUP_ID;
//  3.–5. the same body, a near-same body and the same metadata are flagged by DocumentWriter at commit and projected by
//     the dry run's projector (this file supplies its in-memory near-duplicate index).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// The committed batch that already imported a file into a collection.
public struct CommittedFile: Sendable, Equatable {
  public var batch: Int64
  public var committedAt: String?
  public var fileName: String?
}

public enum Dedupe {
  /// Whole-document MinHash Jaccard at or above which two texts are near duplicates (§5.4).
  public static let nearDupJaccard = 0.9

  /// `committedBatchForFile(db, {collectionSlug, sha256, exceptBatch})`.
  public static func committedBatchForFile(_ c: Connection, collection: String, sha256: String, exceptBatch: Int64? = nil) throws -> CommittedFile? {
    try c.prepared(ImportSQL.committedBatchForFile).bindingFirst([.text(collection), .text(sha256), .integer(exceptBatch.map(Int.init))]) {
      CommittedFile(batch: $0.int(0), committedAt: $0.textOrNil(1), fileName: $0.textOrNil(2))
    }
  }

  /// `dupFileIssue(found, collectionSlug)`: the fatal E_DUP_FILE issue.
  public static func dupFileIssue(_ found: CommittedFile, collection: String) -> Issue {
    let d = JSString.slice(found.committedAt ?? "", 0, 10)
    let date = d.isEmpty ? "an earlier date" : d
    return Issue(code: "E_DUP_FILE", severity: "fatal", line: nil, col: nil, field: nil, valueExcerpt: found.fileName,
      message: "Already imported on \(date) as batch \(found.batch).",
      suggestion: "Open batch \(found.batch) instead, import a changed file, or import into a collection other than '\(collection)'.")
  }

  /// `createIdTracker(db, {collectionSlug})`: ext_ids within one import, checked against the collection.
  public final class IdTracker {
    var seen: [UnitKey: Int?] = [:]
    var collectionID: Int64??
    let collectionSlug: String?

    public init(collection: String?) { collectionSlug = collection }

    /// The E_DUP_ID rejection of a repeated or existing id, or nil (`c` nil: no atlas checks).
    public func check(_ extID: String, line: Int?, on c: Connection?) throws -> Issue? {
      let lineText = line.map(String.init) ?? "?"
      if let first = seen[UnitKey(extID)] {
        return Issue(code: "E_DUP_ID", severity: "rejected", line: line, col: nil, field: "ext_id", valueExcerpt: extID,
          message: "Row \(lineText) repeats id '\(extID)' first seen on line \(first.map(String.init) ?? "?").",
          suggestion: "Give every record a unique id; the repeated row was skipped (the first one is kept).")
      }
      guard let c, let slug = collectionSlug else { return nil }
      if collectionID == nil {
        collectionID = .some(try c.prepared(ImportSQL.collectionIDBySlug).bindingFirst([.text(slug)]) { $0.int(0) })
      }
      guard let coll = collectionID ?? nil else { return nil }
      let row = try c.prepared(ImportSQL.existingExt).bindingFirst([.int(coll), .text(extID)]) {
        (deletedAt: $0.textOrNil(1), batch: $0.intOrNil(2))
      }
      guard let e = row else { return nil }
      let reverted = e.deletedAt != nil ? ", since reverted" : ""
      return Issue(code: "E_DUP_ID", severity: "rejected", line: line, col: nil, field: "ext_id", valueExcerpt: extID,
        message: "Row \(lineText) id '\(extID)' already exists in collection '\(slug)' (import batch \(e.batch.map(String.init) ?? "null")\(reverted)).",
        suggestion: e.deletedAt != nil ? "Import into a new collection: reverted documents keep their ids."
          : "Import changed records into a new collection, or revert the earlier import first and use a new collection.")
    }

    public func accept(_ extID: String, line: Int?) { seen[UnitKey(extID)] = .some(line) }
    public func has(_ extID: String) -> Bool { seen[UnitKey(extID)] != nil }
  }

  /// `createNearDupIndex()`: an in-memory LSH index of MinHash signatures (16 bands × 8 rows over 128 permutations);
  /// ids are labels ("document 12", "the row on line 7").
  public final class NearDupIndex {
    var buckets: [UInt64: [Int]] = [:]
    var labels: [String] = []
    var sigs: [[UInt32]] = []

    public init() {}

    public func add(_ label: String, _ sig: [UInt32]) {
      let k = labels.count
      labels.append(label)
      sigs.append(sig)
      let hs = DupIndex.bandHashes(sig)
      for b in 0..<DupIndex.bands { buckets[UInt64(b) << 32 | UInt64(hs[b]), default: []].append(k) }
    }

    /// The best match at or above the threshold (the first of equals), or nil.
    public func query(_ sig: [UInt32]) -> (label: String, j: Double)? {
      var seen = Set<Int>()
      var best: (label: String, j: Double)?
      let hs = DupIndex.bandHashes(sig)
      for b in 0..<DupIndex.bands {
        for k in buckets[UInt64(b) << 32 | UInt64(hs[b])] ?? [] where seen.insert(k).inserted {
          let j = MinHash.jaccard(sig, sigs[k])
          if j >= Dedupe.nearDupJaccard && (best == nil || j > best!.j) { best = (labels[k], j) }
        }
      }
      return best
    }

    public var count: Int { labels.count }
  }
}
