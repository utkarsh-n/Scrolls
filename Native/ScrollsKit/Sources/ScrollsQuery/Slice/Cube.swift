// OWNER: N3
// Port of server/aggregate/cube.mjs (version 5, RF-1): the slice cube — one row per doc_tokens row of a corpus's
// documents in rate-eligible collections, with every column the slice filters and the lane facets read. Every
// expression-independent aggregate — denominators per tier, lane coverage, lane gates, the modality seam, concordance
// totals, the corpus size — is computed from it under exactly the slice rules of SliceSQL, instead of a SQL scan per
// (tier, facet, filter). The cube is a columnar file in Caches/ (IOS-SPEC §1.3), mapped read-only, built once per state
// of its inputs (`InputsKey.corpus(.rate)`); a materialization never touches it. Rows of one document are contiguous.
// A second cube holds a corpus's relation-endpoint collections (only the Term trail reads them).

import Foundation
import ScrollsCore
import ScrollsStore
import Synchronization

/// A collection as the cube knows it.
public struct CubeCollection: Sendable, Codable, Equatable {
  public var id: Int64
  public var slug: String
  public var domain: String
  public var modality: String
  public var unit: String
  public var coverageGate: Int?
  public var sampling: String?
  public var rateEligible: Bool
}

/// A denominator of one lane × bin.
public struct CubeDenominator: Sendable, Equatable {
  public var lane: String
  public var uc: String
  public var bin: Int
  public var tokens: Double
  public var docs: Int
  public var syn: Bool
  public var tr: Bool
}

/// A lane's coverage in a slice.
public struct CubeCoverage: Sendable, Equatable {
  public var lv: String?
  public var uc: String
  public var tokens: Double
  public var docs: Int
  public var spanLo: Int?
  public var spanHi: Int?
  public var binLo: Int?
  public var binHi: Int?
  public var syn: Bool
  /// Samplings of the lane's collections, sorted and comma-joined.
  public var samplings: String
  public var outsideTokens: Double
}

/// A (lane, collection) pair of a slice: the input of the lane gates.
public struct CubeGateRow: Sendable, Equatable {
  public var lv: String?
  public var uc: String
  public var unit: String
  public var coverageGate: Int?
  public var sampling: String?
}

/// The slice cube of one corpus.
public final class SliceCube: @unchecked Sendable {
  public static let version = 5
  static let magic: UInt32 = 0x5343_4231  // 'SCB1'
  static let fieldClasses = ["text", "title", "abstract", "describes", "apparatus"]
  static let unitOfFC = [0, 1, 2, 0, 0]
  static let unitClasses = ["text", "titles", "abstracts"]
  static let chrono = ["dated", "undated", "scheduled"]
  static let dictNames = ["plang", "kind", "culture", "field", "community", "basis", "dlang"]
  static let fTR: UInt8 = 1, fDUP: UInt8 = 2, fSYN: UInt8 = 4
  static let noYear: Int32 = Int32.min

  /// Column name → element size, in the reference's layout order.
  static let columns: [(name: String, size: Int)] = [
    ("doc", 4), ("tokens", 8), ("batch", 4), ("ylo", 4), ("yhi", 4), ("lod", 4), ("hid", 4), ("coll", 4), ("plang", 4),
    ("kind", 4), ("culture", 4), ("field", 4), ("community", 4), ("basis", 4), ("fc", 1), ("cs", 1), ("flags", 1), ("del", 8),
    ("dlang", 4),
  ]

  public let corpusId: Int64
  public let endpoints: Bool
  public let n: Int
  public let colls: [CubeCollection]
  /// Dictionaries: code 0 is null.
  public let dicts: [String: [String?]]

  let doc: UnsafeBufferPointer<Int32>
  let tokens: UnsafeBufferPointer<Double>
  let batch: UnsafeBufferPointer<Int32>
  let ylo: UnsafeBufferPointer<Int32>
  let yhi: UnsafeBufferPointer<Int32>
  let lod: UnsafeBufferPointer<Int32>
  let hid: UnsafeBufferPointer<Int32>
  let coll: UnsafeBufferPointer<UInt32>
  let plang: UnsafeBufferPointer<UInt32>
  let kind: UnsafeBufferPointer<UInt32>
  let culture: UnsafeBufferPointer<UInt32>
  let field: UnsafeBufferPointer<UInt32>
  let community: UnsafeBufferPointer<UInt32>
  let basis: UnsafeBufferPointer<UInt32>
  let fc: UnsafeBufferPointer<UInt8>
  let cs: UnsafeBufferPointer<UInt8>
  let flags: UnsafeBufferPointer<UInt8>
  let del: UnsafeBufferPointer<Double>
  let dlang: UnsafeBufferPointer<UInt32>

  /// What keeps the columns alive: an owned buffer or a file mapping.
  private let owner: AnyObject
  /// Per-cube memo of slice aggregates (keys: aggregate, slice, facet, tier).
  let memo = Mutex<[String: Artifacts.Box]>([:])

  final class Owned {
    let base: UnsafeMutableRawPointer
    init(bytes: Int) { base = UnsafeMutableRawPointer.allocate(byteCount: max(8, bytes), alignment: 16) }
    deinit { base.deallocate() }
  }

  struct Header: Codable {
    var version: Int
    var corpusId: Int64
    var endpoints: Bool
    var n: Int
    var colls: [CubeCollection]
    var dicts: [String: [String?]]
    var layout: [Layout]
    struct Layout: Codable {
      var name: String
      var offset: Int
      var length: Int
    }
  }

  private init(header: Header, body: UnsafeRawPointer, owner: AnyObject) {
    corpusId = header.corpusId
    endpoints = header.endpoints
    n = header.n
    colls = header.colls
    dicts = header.dicts
    self.owner = owner
    let at = Dictionary(uniqueKeysWithValues: header.layout.map { ($0.name, $0.offset) })
    func col<T>(_ name: String, _ t: T.Type) -> UnsafeBufferPointer<T> {
      UnsafeBufferPointer(start: (body + at[name]!).assumingMemoryBound(to: T.self), count: header.n)
    }
    doc = col("doc", Int32.self)
    tokens = col("tokens", Double.self)
    batch = col("batch", Int32.self)
    ylo = col("ylo", Int32.self)
    yhi = col("yhi", Int32.self)
    lod = col("lod", Int32.self)
    hid = col("hid", Int32.self)
    coll = col("coll", UInt32.self)
    plang = col("plang", UInt32.self)
    kind = col("kind", UInt32.self)
    culture = col("culture", UInt32.self)
    field = col("field", UInt32.self)
    community = col("community", UInt32.self)
    basis = col("basis", UInt32.self)
    fc = col("fc", UInt8.self)
    cs = col("cs", UInt8.self)
    flags = col("flags", UInt8.self)
    del = col("del", Double.self)
    dlang = col("dlang", UInt32.self)
  }

  /// The layout of the columns of `n` rows: each column at an 8-aligned offset.
  static func layout(_ n: Int) -> (layout: [Header.Layout], bytes: Int) {
    var offset = 0
    var out: [Header.Layout] = []
    for (name, size) in columns {
      offset = (offset + 7) / 8 * 8
      out.append(Header.Layout(name: name, offset: offset, length: n))
      offset += size * n
    }
    return (out, offset)
  }

  // MARK: build

  /// `buildCube(db, corpusId, {endpoints})`: scans the corpus once into columns.
  public static func build(_ c: Connection, corpusId: Int64, endpoints: Bool = false) throws -> SliceCube {
    let cs = try c.prepared(CubeSQL.collections)
    try cs.bind([.int(corpusId), .int(endpoints ? 0 : 1)])
    let colls = try cs.all { r in
      CubeCollection(id: r.int(0), slug: r.text(1), domain: r.text(2), modality: r.text(3), unit: r.text(4),
                     coverageGate: r.intOrNil(5).map(Int.init), sampling: r.textOrNil(6), rateEligible: r.int(7) == 1)
    }
    let collIndex = Dictionary(uniqueKeysWithValues: colls.enumerated().map { ($0.element.id, UInt32($0.offset)) })
    var dictValues: [String: [String?]] = [:]
    var dictIndex: [String: [String: UInt32]] = [:]
    for d in dictNames {
      dictValues[d] = [nil]
      dictIndex[d] = [:]
    }
    func code(_ d: String, _ v: String?) -> UInt32 {
      guard let v else { return 0 }
      if let c = dictIndex[d]![v] { return c }
      let c = UInt32(dictValues[d]!.count)
      dictValues[d]!.append(v)
      dictIndex[d]![v] = c
      return c
    }
    var docC: [Int32] = [], tokC: [Double] = [], batchC: [Int32] = [], yloC: [Int32] = [], yhiC: [Int32] = [], lodC: [Int32] = [],
      hidC: [Int32] = [], collC: [UInt32] = [], plangC: [UInt32] = [], kindC: [UInt32] = [], cultureC: [UInt32] = [],
      fieldC: [UInt32] = [], communityC: [UInt32] = [], basisC: [UInt32] = [], fcC: [UInt8] = [], csC: [UInt8] = [],
      flagsC: [UInt8] = [], delC: [Double] = [], dlangC: [UInt32] = []
    let s = try c.prepared(CubeSQL.build)
    try s.bind([.int(corpusId), .int(endpoints ? 0 : 1)])
    while let r = try s.step() {
      docC.append(Int32(r.int(0)))
      plangC.append(code("plang", r.textOrNil(1)))
      fcC.append(UInt8(fieldClasses.firstIndex(of: r.text(2)) ?? 255))
      tokC.append(r.double(3))
      collC.append(collIndex[r.int(4)] ?? UInt32.max)
      kindC.append(code("kind", r.textOrNil(5)))
      cultureC.append(code("culture", r.textOrNil(6)))
      fieldC.append(code("field", r.textOrNil(7)))
      communityC.append(code("community", r.textOrNil(8)))
      basisC.append(code("basis", r.textOrNil(9)))
      flagsC.append((r.int(10) != 0 ? fTR : 0) | (r.int(11) != 0 ? fDUP : 0) | (r.int(12) != 0 ? fSYN : 0))
      batchC.append(r.isNull(13) ? 0 : Int32(r.int(13)))
      csC.append(UInt8(chrono.firstIndex(of: r.text(14)) ?? 255))
      yloC.append(r.isNull(15) ? noYear : Int32(r.int(15)))
      yhiC.append(r.isNull(16) ? noYear : Int32(r.int(16)))
      lodC.append(r.isNull(17) ? noYear : Int32(r.int(17)))
      hidC.append(r.isNull(18) ? noYear : Int32(r.int(18)))
      delC.append(epochSeconds(r.textOrNil(19)))
      dlangC.append(code("dlang", r.textOrNil(20)))
    }
    let n = docC.count
    // rows of each document contiguous (stable sort by document) unless they already are
    var order: [Int]?
    var seen = Set<Int32>()
    var ok = true
    for r in 0..<n where ok {
      if r > 0 && docC[r] == docC[r - 1] { continue }
      if !seen.insert(docC[r]).inserted { ok = false }
    }
    if !ok { order = (0..<n).sorted { docC[$0] != docC[$1] ? docC[$0] < docC[$1] : $0 < $1 } }
    let (layout, bytes) = Self.layout(n)
    let owned = Owned(bytes: bytes)
    func put<T>(_ name: String, _ src: [T]) {
      let off = layout.first { $0.name == name }!.offset
      let dst = (owned.base + off).assumingMemoryBound(to: T.self)
      if let order { for i in 0..<n { dst[i] = src[order[i]] } } else { for i in 0..<n { dst[i] = src[i] } }
    }
    put("doc", docC); put("tokens", tokC); put("batch", batchC); put("ylo", yloC); put("yhi", yhiC); put("lod", lodC)
    put("hid", hidC); put("coll", collC); put("plang", plangC); put("kind", kindC); put("culture", cultureC); put("field", fieldC)
    put("community", communityC); put("basis", basisC); put("fc", fcC); put("cs", csC); put("flags", flagsC); put("del", delC)
    put("dlang", dlangC)
    let header = Header(version: version, corpusId: corpusId, endpoints: endpoints, n: n, colls: colls, dicts: dictValues, layout: layout)
    return SliceCube(header: header, body: UnsafeRawPointer(owned.base), owner: owned)
  }

  // MARK: file form

  /// Magic, header length, JSON header, columns (8-aligned).
  public func encode() throws -> Data {
    let (layout, bytes) = Self.layout(n)
    let header = Header(version: Self.version, corpusId: corpusId, endpoints: endpoints, n: n, colls: colls, dicts: dicts, layout: layout)
    let head = try JSONEncoder().encode(header)
    let start = (8 + head.count + 7) / 8 * 8
    var out = Data(count: start + bytes)
    out.withUnsafeMutableBytes { raw in
      let p = raw.baseAddress!
      p.storeBytes(of: Self.magic.littleEndian, toByteOffset: 0, as: UInt32.self)
      p.storeBytes(of: UInt32(head.count).littleEndian, toByteOffset: 4, as: UInt32.self)
      head.withUnsafeBytes { (p + 8).copyMemory(from: $0.baseAddress!, byteCount: head.count) }
      func copy<T>(_ name: String, _ col: UnsafeBufferPointer<T>) {
        let off = layout.first { $0.name == name }!.offset
        if n > 0 { (p + start + off).copyMemory(from: UnsafeRawPointer(col.baseAddress!), byteCount: MemoryLayout<T>.stride * n) }
      }
      copy("doc", doc); copy("tokens", tokens); copy("batch", batch); copy("ylo", ylo); copy("yhi", yhi); copy("lod", lod)
      copy("hid", hid); copy("coll", coll); copy("plang", plang); copy("kind", kind); copy("culture", culture); copy("field", field)
      copy("community", community); copy("basis", basis); copy("fc", fc); copy("cs", cs); copy("flags", flags); copy("del", del)
      copy("dlang", dlang)
    }
    return out
  }

  struct DecodeError: Error, CustomStringConvertible { let description: String }

  /// A cube over mapped (or owned) bytes in the file form.
  static func decode(_ bytes: UnsafeRawBufferPointer, owner: AnyObject) throws -> SliceCube {
    guard bytes.count >= 8, let base = bytes.baseAddress,
      UInt32(littleEndian: base.loadUnaligned(as: UInt32.self)) == magic
    else { throw DecodeError(description: "not a slice cube") }
    let len = Int(UInt32(littleEndian: base.loadUnaligned(fromByteOffset: 4, as: UInt32.self)))
    guard 8 + len <= bytes.count else { throw DecodeError(description: "truncated slice cube") }
    let header = try JSONDecoder().decode(Header.self, from: Data(bytes: base + 8, count: len))
    guard header.version == version else { throw DecodeError(description: "slice cube of another version") }
    let start = (8 + len + 7) / 8 * 8
    let (_, need) = layout(header.n)
    guard start + need <= bytes.count else { throw DecodeError(description: "truncated slice cube") }
    return SliceCube(header: header, body: base + start, owner: owner)
  }

  /// `epochSeconds(iso)`: seconds since 1970 of an ISO timestamp; 0 for none.
  public static func epochSeconds(_ iso: String?) -> Double {
    guard let iso else { return 0 }
    let u = Array(iso.utf8)
    func num(_ a: Int, _ b: Int) -> Int? {
      guard b <= u.count, a < b else { return nil }
      var v = 0
      for i in a..<b {
        guard u[i] >= 0x30 && u[i] <= 0x39 else { return nil }
        v = v * 10 + Int(u[i] - 0x30)
      }
      return v
    }
    guard let y = num(0, 4), let mo = num(5, 7), let d = num(8, 10), let h = num(11, 13), let mi = num(14, 16), let s = num(17, 19)
    else { return 0 }
    var frac = 0.0
    if u.count > 20, u[19] == 0x2E {
      var k = 20, scale = 0.1
      while k < u.count, u[k] >= 0x30, u[k] <= 0x39 {
        frac += Double(u[k] - 0x30) * scale
        scale /= 10
        k += 1
      }
    }
    let ms = (Double(DayMath.dayFromYMD(y, mo, d)) * 86_400 + Double(h * 3600 + mi * 60 + s)) * 1000 + (frac * 1000).rounded()
    return ms / 1000
  }

  // MARK: memo

  func memoized<T: Sendable>(_ key: String, _ compute: () throws -> T) rethrows -> T {
    if let hit = memo.withLock({ $0[key] })?.value as? T { return hit }
    let v = try compute()
    let box = Artifacts.Box(v)
    memo.withLock { m in
      if m.count > 96 { m.removeAll() }
      m[key] = box
    }
    return v
  }
}

/// Shared cubes of an atlas.
public enum Cubes {
  /// The sharedArtifact name of a corpus's cube.
  static func name(_ corpusId: Int64, endpoints: Bool) -> String { "\(endpoints ? "ecube" : "cube")\(SliceCube.version)-c\(corpusId)" }

  /// `sliceCube(db, corpusId)` (or the relation-endpoint cube): memory → mapped cache file → one scan.
  public static func cube(_ c: Connection, _ corpusId: Int64, endpoints: Bool = false) throws -> SliceCube {
    let name = name(corpusId, endpoints: endpoints)
    let key: (Connection) throws -> String = { try InputsKey.corpus($0, corpusId, scope: endpoints ? .endpoints : .rate) }
    return try Artifacts.sharedValue(c, name: name, key: key, build: { try SliceCube.build($0, corpusId: corpusId, endpoints: endpoints) },
                                     encode: { try $0.encode() }, decode: { data in
      // the cache file is mapped (clean, purgeable pages); a mapping over the budget falls back to a copy
      let copy = SliceCube.Owned(bytes: data.count)
      data.withUnsafeBytes { copy.base.copyMemory(from: $0.baseAddress!, byteCount: data.count) }
      return try SliceCube.decode(UnsafeRawBufferPointer(start: copy.base, count: data.count), owner: copy)
    }, mappedDecode: { url in
      let mapped = try MappedFileRegistry.map(url, purpose: "slice cube")
      return try SliceCube.decode(mapped.bytes, owner: mapped)
    }, ext: "cube")
  }

  /// The cubes of a def's corpora (+ relation-endpoint cubes on the Term trail).
  public static func of(_ c: Connection, _ def: QueryDef) throws -> [SliceCube] {
    var out = try def.corpusIds.map { try cube(c, $0) }
    if def.lanes.facet == "trail" {
      for id in def.corpusIds {
        let e = try cube(c, id, endpoints: true)
        if e.n > 0 { out.append(e) }
      }
    }
    return out
  }
}

/// Statements of the slice cube.
public enum CubeSQL: SQLCatalog {
  static let collections = SQL("q.cube.collections", """
    SELECT id, slug, domain, modality, unit, coverage_gate, sampling, rate_eligible FROM collection
      WHERE corpus_id = ? AND rate_eligible = ? ORDER BY id
    """, scan: .scanOK(reason: "collections (tens)"))
  static let build = SQL("q.cube.build", """
    SELECT t.document_id, t.plang, t.field_class, t.tokens, d.collection_id, d.kind, d.culture, d.field, d.community,
        d.basis, d.is_translation, d.dup_of IS NOT NULL, d.is_synthetic, d.import_batch_id, d.chrono_status, d.y_lo, d.y_hi, d.lo_day, d.hi_day,
        d.deleted_at, d.lang_text
      FROM collection c JOIN document d ON d.collection_id = c.id JOIN doc_tokens t ON t.document_id = d.id
      WHERE c.corpus_id = ? AND c.rate_eligible = ? AND (c.rate_eligible = 1 OR c.sampling = 'relation_endpoints')
    """, scan: .scanOK(reason: "the cube is one scan of a corpus, once per state of its inputs"))

  public static let all: [SQL] = [collections, build]
}
