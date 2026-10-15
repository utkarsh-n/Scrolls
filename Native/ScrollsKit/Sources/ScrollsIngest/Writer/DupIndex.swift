// OWNER: N1
// Port of server/store/dup-index.mjs and the MinHash of store/document-writer.mjs (SPEC §5.4, M5 gate item 9): the
// duplicate indexes of one collection, built once per chained load.
//
// DocumentWriter flags near duplicates (MinHash LSH over full texts) and metadata duplicates (folded
// title|author|year of metadata-only records) against everything already in the collection. Building those indexes
// means reading every signature and folding every title, and a chained load (Cipher phase A2, STEMM chunks) creates a
// new writer per chunk, so the index outlives its writer: the finished writer hands it to the next writer of the same
// collection through an in-process memo. A reused index is trusted only while the collection's import batches are
// exactly as recorded (a revert or a rollback changes a batch's status and forces a rebuild); documents added since are
// read from the database by id (> watermark). Hits are re-checked against the database by the writer, so a stale entry
// can never flag a duplicate that is not there. The reference's on-disk copy of a large index is a cache with the same
// contents (its loss only costs time); the phone keeps the memo (IOS-SPEC §3.1 "dup indexes", later in Atlas/derived).
// Candidate order, ties and LSH bucket order are the reference's, so the duplicate a writer names is the same document.

import Foundation
import ScrollsCore
import ScrollsStore
import Synchronization

/// MinHash over 5-token shingles (128 permutations), as document-writer.mjs computes it.
public enum MinHash {
  public static let permutations = 128
  public static let shingle = 5
  public static let minTokens = 20

  static let perms: (a: [UInt32], b: [UInt32]) = {
    var rnd = Mulberry32(seed: 0x5C2011)
    var a = [UInt32](repeating: 0, count: permutations), b = a
    for i in 0..<permutations {
      a[i] = UInt32((rnd.next() * 4_294_967_295).rounded(.down)) | 1
      b[i] = UInt32((rnd.next() * 4_294_967_295).rounded(.down))
    }
    return (a, b)
  }()

  /// FNV-1a over the UTF-16 code units of a token.
  @inline(__always)
  static func tokenHash(_ t: String) -> UInt32 {
    var h: UInt32 = 0x811C_9DC5
    for u in t.utf16 { h = (h ^ UInt32(u)) &* 0x0100_0193 }
    return h
  }

  /// `minhashSignature(tokens)`: nil when there are fewer than 20 tokens.
  public static func signature(_ tokens: [String]) -> [UInt32]? {
    if tokens.count < minTokens { return nil }
    let th = tokens.map(tokenHash)
    var shingles = Set<UInt32>()
    var i = 0
    while i + shingle <= th.count {
      var h: UInt32 = 0x811C_9DC5
      for j in 0..<shingle { h = (h ^ th[i + j]) &* 0x0100_0193 }
      shingles.insert(h)
      i += 1
    }
    var sig = [UInt32](repeating: 0xFFFF_FFFF, count: permutations)
    let (pa, pb) = perms
    for h in shingles {
      for p in 0..<permutations {
        let v = (pa[p] &* h) &+ pb[p]
        if v < sig[p] { sig[p] = v }
      }
    }
    return sig
  }

  /// Estimated Jaccard similarity of two signatures.
  public static func jaccard(_ a: [UInt32], _ b: [UInt32]) -> Double {
    var eq = 0
    for i in 0..<a.count where a[i] == b[i] { eq += 1 }
    return Double(eq) / Double(a.count)
  }

  /// The stored form (`new Uint8Array(sig.buffer)`: little-endian u32s).
  public static func bytes(_ sig: [UInt32]) -> [UInt8] {
    var out = [UInt8]()
    out.reserveCapacity(sig.count * 4)
    for v in sig { out += [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8(v >> 24)] }
    return out
  }

  /// A stored signature back to u32s.
  public static func signature(bytes: [UInt8]) -> [UInt32] {
    var out = [UInt32]()
    out.reserveCapacity(bytes.count / 4)
    var i = 0
    while i + 3 < bytes.count {
      out.append(UInt32(bytes[i]) | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2]) << 16 | UInt32(bytes[i + 3]) << 24)
      i += 4
    }
    return out
  }
}

/// The duplicate indexes of one collection (owned by one writer at a time).
public final class DupIndex: @unchecked Sendable {
  static let bands = 16
  static let rows = 8
  /// Above this many signatures, near duplicates are checked within the batch only (memory).
  public static let maxSignatures = 100_000

  let collectionID: Int64
  var watermark: Int64 = 0
  var batches: [(id: Int64, status: String)] = []
  var batchesAtOpen: [(id: Int64, status: String)]?
  var sigs: [Int64: [UInt32]] = [:]
  /// band · 2³² + hash → ids, in insertion order (signatures added after the base was built).
  var lsh: [UInt64: [Int64]] = [:]
  /// Per band, the (hash, id) pairs of the signatures present when the base was built, sorted by hash then id.
  var base: [[(hash: UInt32, id: Int64)]]?
  var lshComplete = true
  var metaKeys: [String: Int64] = [:]

  init(collectionID: Int64) { self.collectionID = collectionID }

  /// FNV-1a hash of each of the 16 bands (8 rows) of a signature.
  static func bandHashes(_ sig: [UInt32]) -> [UInt32] {
    var out = [UInt32](repeating: 0, count: bands)
    for b in 0..<bands {
      var h: UInt32 = 0x811C_9DC5
      for r in 0..<rows { h = (h ^ sig[b * rows + r]) &* 0x0100_0193 }
      out[b] = h
    }
    return out
  }

  func buildBase() {
    var out = [[(hash: UInt32, id: Int64)]](repeating: [], count: DupIndex.bands)
    for (id, sig) in sigs {
      let hs = DupIndex.bandHashes(sig)
      for b in 0..<DupIndex.bands { out[b].append((hs[b], id)) }
    }
    for b in 0..<DupIndex.bands { out[b].sort { $0.hash != $1.hash ? $0.hash < $1.hash : $0.id < $1.id } }
    base = out
  }

  /// `addSignature(index, id, sig)`.
  func add(_ id: Int64, _ sig: [UInt32]) {
    sigs[id] = sig
    let hs = DupIndex.bandHashes(sig)
    for b in 0..<DupIndex.bands { lsh[UInt64(b) << 32 | UInt64(hs[b]), default: []].append(id) }
  }

  /// `lshCandidates(index, sig)`: ids sharing at least one band (each once, in the reference's order).
  func candidates(_ sig: [UInt32]) -> [(id: Int64, sig: [UInt32]?)] {
    var seen = Set<Int64>()
    var order: [Int64] = []
    func see(_ id: Int64) { if seen.insert(id).inserted { order.append(id) } }
    let hs = DupIndex.bandHashes(sig)
    for b in 0..<DupIndex.bands {
      let h = hs[b]
      for id in lsh[UInt64(b) << 32 | UInt64(h)] ?? [] { see(id) }
      guard let base, !base[b].isEmpty else { continue }
      let list = base[b]
      var lo = 0, hi = list.count
      while lo < hi {
        let mid = (lo + hi) >> 1
        if list[mid].hash < h { lo = mid + 1 } else { hi = mid }
      }
      while lo < list.count && list[lo].hash == h {
        see(list[lo].id)
        lo += 1
      }
    }
    return order.map { ($0, sigs[$0]) }
  }

  /// Folds the signatures added since the base into a new base (before the index is kept).
  func compact() {
    if !lshComplete || (lsh.isEmpty && (base?.first?.count ?? 0) == sigs.count && base != nil) { return }
    buildBase()
    lsh = [:]
  }

  /// `metaKey(doc, yLo)`: folded title | folded author | first year.
  public static func metaKey(title: String?, author: String?, yLo: Int?) -> String {
    let f: (String?) -> String = { Tokenizer.tokens($0 ?? "").tokens.joined(separator: " ") }
    return "\(f(title))|\(f(author))|\(yLo.map(String.init) ?? "")"
  }

  // MARK: opening and keeping (openDupIndex / saveDupIndex)

  private struct MemoKey: Hashable {
    let db: String
    let created: String
    let collection: Int64
  }
  private static let memo = Mutex<[MemoKey: DupIndex]>([:])

  /// Forgets every in-process index (tests).
  public static func clearMemo() { memo.withLock { $0.removeAll() } }

  static func batchesOf(_ c: Connection, _ collection: Int64) throws -> [(id: Int64, status: String)] {
    try c.prepared(IngestSQL.batchesOfCollection).bindingAll([.int(collection)]) { ($0.int(0), $0.text(1)) }
  }

  /// Every recorded batch is still there with the same status; any other batch is newer than all recorded ones.
  static func batchesUnchanged(_ recorded: [(id: Int64, status: String)], _ current: [(id: Int64, status: String)]) -> Bool {
    var was: [Int64: String] = [:]
    for r in recorded { was[r.id] = r.status }
    let maxRecorded = recorded.last?.id ?? 0
    var seen = 0
    for c in current {
      if let s = was[c.id] {
        if s != c.status { return false }
        seen += 1
      } else if c.id < maxRecorded {
        return false
      }
    }
    return seen == was.count
  }

  private static func key(_ c: Connection, _ collection: Int64) throws -> MemoKey {
    MemoKey(db: c.path, created: try c.prepared(IngestSQL.metaGet).bindingFirst([.text("created_at")]) { $0.text(0) } ?? "",
            collection: collection)
  }

  /// `openDupIndex(db, collectionId)`: the memo of this process (topped up with documents added since), else built
  /// from the database. The writer owns the returned index until `save` or it drops it.
  static func open(_ c: Connection, collection: Int64) throws -> (index: DupIndex, source: String) {
    let k = try key(c, collection)
    let current = try batchesOf(c, collection)
    var index = memo.withLock { $0.removeValue(forKey: k) }
    if let i = index, !batchesUnchanged(i.batches, current) { index = nil }
    let source: String
    if let i = index {
      i.watermark = try i.readSince(c, after: i.watermark)
      i.batches = current
      source = "memo"
    } else {
      let i = DupIndex(collectionID: collection)
      let n = try c.prepared(IngestSQL.signatureCount).bindingFirst([.int(collection)]) { $0.int(0) } ?? 0
      i.lshComplete = n <= maxSignatures
      i.batches = current
      i.watermark = try i.readAll(c)
      index = i
      source = "db"
    }
    index!.batchesAtOpen = current
    return (index!, source)
  }

  /// Every signature and metadata key of the collection's live documents; returns the highest id read.
  private func readAll(_ c: Connection) throws -> Int64 {
    var maxID: Int64 = 0
    if lshComplete {
      let s = try c.prepared(IngestSQL.signaturesOfCollection)
      try s.bind(.int(collectionID))
      while let r = try s.step() {
        let id = r.int(0)
        sigs[id] = MinHash.signature(bytes: r.blob(1))
        if id > maxID { maxID = id }
      }
      buildBase()
    }
    let m = try c.prepared(IngestSQL.metaKeysOfCollection)
    try m.bind(.int(collectionID))
    while let r = try m.step() {
      let id = r.int(0)
      metaKeys[DupIndex.metaKey(title: r.textOrNil(1), author: r.textOrNil(2), yLo: r.intOrNil(3).map(Int.init))] = id
      if id > maxID { maxID = id }
    }
    return maxID
  }

  /// The collection's live documents with id > after, added to a reused index; returns the new watermark.
  private func readSince(_ c: Connection, after: Int64) throws -> Int64 {
    var maxID = after
    let s = try c.prepared(IngestSQL.documentsSince)
    try s.bind(.int(collectionID), .int(after))
    var rows: [(id: Int64, title: String?, author: String?, yLo: Int?, full: Bool)] = []
    while let r = try s.step() { rows.append((r.int(0), r.textOrNil(1), r.textOrNil(2), r.intOrNil(3).map(Int.init), r.int(4) != 0)) }
    for r in rows {
      if !r.full {
        metaKeys[DupIndex.metaKey(title: r.title, author: r.author, yLo: r.yLo)] = r.id
      } else if lshComplete,
        let blob = try c.prepared(IngestSQL.signatureOf).bindingFirst([.int(r.id)], { $0.blob(0) })
      {
        add(r.id, MinHash.signature(bytes: blob))
      }
      if r.id > maxID { maxID = r.id }
    }
    return maxID
  }

  /// `saveDupIndex`: after the writer's batch committed, keeps the index for the next writer of this collection —
  /// skipped when another batch of the collection changed while the writer ran.
  @discardableResult
  func save(_ c: Connection, batch: Int64, maxDocumentID: Int64) throws -> Bool {
    let current = try DupIndex.batchesOf(c, collectionID)
    func others(_ l: [(id: Int64, status: String)]) -> [String] { l.filter { $0.id != batch }.map { "\($0.id):\($0.status)" } }
    if others(current) != others(batchesAtOpen ?? []) { return false }
    batches = current
    watermark = max(watermark, maxDocumentID)
    batchesAtOpen = nil
    if !lshComplete || sigs.count > DupIndex.maxSignatures {
      // near duplicates are then checked within each batch only: the next writer starts with no signatures
      lshComplete = false
      sigs = [:]
      lsh = [:]
      base = nil
    }
    compact()
    let k = try DupIndex.key(c, collectionID)
    DupIndex.memo.withLock { $0[k] = self }
    return true
  }
}

extension Statement {
  /// Binds `values` and maps every row.
  func bindingAll<T>(_ values: [SQLValue], _ map: (Row) throws -> T) throws -> [T] {
    try bind(values)
    return try all(map)
  }
}
