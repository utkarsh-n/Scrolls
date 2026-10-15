// OWNER: N0
// The device profile's text layout (IOS-SPEC §3.4, DP-1): an original is cut into passage-aligned chunks — a chunk
// closes at the first passage end at or after 16,384 UTF-16 units and never grows past 65,536 (a single longer passage
// is its own chunk), no passage spans two chunks and no boundary splits a surrogate pair — and each chunk is stored as
// LZFSE over UTF-8 ('lzfse-utf8'), or raw UTF-8 ('utf8') under 2 KB or when compression does not help. A read decodes
// only the chunks its range covers, through a per-connection LRU of decoded chunks.

import Compression
import Foundation
import ScrollsContracts

/// What `ChunkedTextStore.Writer.append` stored for one document.
public struct TextStorageRow: Sendable, Equatable {
  public let documentID: DocumentID
  public let layout: String
  public let utf16Len: Int
  public let utf8Len: Int
  public let chunkCount: Int
  /// The UTF-16 ranges of the chunks, in order.
  public let chunks: [Range<Int32>]
  /// sha256 of the whole original's UTF-8 (the value `document_text.original_sha256` must hold).
  public let originalSHA256: String
}

/// Reads chunked documents; documents without a `text_storage` row are read inline (`document_text.original`).
public struct ChunkedTextStore: TextStore {
  public static let layout = "chunked-1"
  /// A chunk closes at the first passage end at or after this many units…
  public static let targetUnits: Int32 = 16_384
  /// …and never exceeds this many, unless a single passage is longer.
  public static let maxUnits: Int32 = 65_536
  /// Chunks whose UTF-8 is smaller than this are stored raw.
  public static let rawBelowBytes = 2_048

  public let cacheBytesPerConnection: Int
  private let inline = InlineTextStore()

  public init(cacheBytesPerConnection: Int = 8 << 20) { self.cacheBytesPerConnection = cacheBytesPerConnection }

  public func utf16(_ doc: DocumentID, _ range: Range<Int32>, on c: Connection) throws -> [UInt16] {
    guard let storage = try storage(doc, on: c) else { return try inline.utf16(doc, range, on: c) }
    guard range.lowerBound >= 0, Int(range.upperBound) <= storage.utf16Len else {
      throw TextStoreError(document: doc.rawValue, message: "range \(range) is outside its \(storage.utf16Len) code units")
    }
    if range.isEmpty { return [] }
    var out: [UInt16] = []
    out.reserveCapacity(range.count)
    for chunk in try chunks(doc, covering: range, on: c) {
      let lo = Int(max(range.lowerBound, chunk.start) - chunk.start)
      let hi = Int(min(range.upperBound, chunk.end) - chunk.start)
      out.append(contentsOf: chunk.units[lo..<hi])
    }
    guard out.count == range.count else {
      throw TextStoreError(document: doc.rawValue, message: "chunks cover \(out.count) of the \(range.count) units of \(range)")
    }
    return out
  }

  public func fullText(_ doc: DocumentID, on c: Connection) throws -> String {
    guard let storage = try storage(doc, on: c) else { return try inline.fullText(doc, on: c) }
    return String(decoding: try utf16(doc, 0..<Int32(storage.utf16Len), on: c), as: UTF16.self)
  }

  /// Drops the decoded chunks cached on `c` (memory warning: `AtlasPlatform.trim()`).
  public static func trim(_ c: Connection) { c.decodedChunks = nil }

  private func storage(_ doc: DocumentID, on c: Connection) throws -> (utf16Len: Int, chunkCount: Int)? {
    guard c.profile == .device else { return nil }
    return try c.prepared(StoreSQL.textStorage).bindingFirst([.int(doc.rawValue)]) { (Int($0.int(1)), Int($0.int(3))) }
  }

  private func chunks(_ doc: DocumentID, covering range: Range<Int32>, on c: Connection) throws -> [DecodedChunk] {
    let cache = c.decodedChunks ?? DecodedChunkCache(capacityBytes: cacheBytesPerConnection)
    c.decodedChunks = cache
    let s = try c.prepared(StoreSQL.chunksCovering)
    try s.bind(.int(doc.rawValue), .int(Int64(range.lowerBound)), .int(Int64(range.upperBound)))
    return try s.all { row -> DecodedChunk in
      let ord = Int(row.int(0)), start = Int32(row.int(1)), end = Int32(row.int(2))
      if let hit = cache.get(doc: doc.rawValue, ord: ord) { return hit }
      let units = try ChunkCodec.decode(codec: row.text(3), row.blob(4), units: Int(end - start), document: doc.rawValue)
      let chunk = DecodedChunk(start: start, end: end, units: units)
      cache.put(doc: doc.rawValue, ord: ord, chunk)
      return chunk
    }
  }

  /// Cuts originals into chunks and writes `text_chunk` and `text_storage` rows. The caller writes the document's
  /// `document_text` row first (with `original = ''` and `original_sha256 = TextDigest.sha256Hex(utf8: original)`).
  public struct Writer {
    public init() {}

    /// Stores `original` in chunks whose boundaries are passage ends (`passageEnds`, UTF-16 offsets into `original`;
    /// the end of the text closes the last chunk).
    public mutating func append(document: DocumentID, original: String, passageEnds: [Int32],
                                on c: Connection) throws -> TextStorageRow {
      guard c.profile == .device else { throw StoreError.misuse("chunked text needs the device profile") }
      let units = Array(original.utf16)
      let ranges = ChunkedTextStore.boundaries(units: units, passageEnds: passageEnds)
      let ins = try c.prepared(StoreSQL.insertChunk)
      var utf8Len = 0
      for (ord, r) in ranges.enumerated() {
        let (codec, bytes, plainBytes) = try ChunkCodec.encode(units[Int(r.lowerBound)..<Int(r.upperBound)])
        utf8Len += plainBytes
        try ins.bind(.int(document.rawValue), .int(Int64(ord)), .int(Int64(r.lowerBound)), .int(Int64(r.upperBound)),
                     .text(codec), .blob(bytes))
        try ins.run()
      }
      let st = try c.prepared(StoreSQL.insertTextStorage)
      try st.bind(.int(document.rawValue), .text(ChunkedTextStore.layout), .int(Int64(units.count)), .int(Int64(utf8Len)),
                  .int(Int64(ranges.count)))
      try st.run()
      return TextStorageRow(documentID: document, layout: ChunkedTextStore.layout, utf16Len: units.count, utf8Len: utf8Len,
                            chunkCount: ranges.count, chunks: ranges, originalSHA256: TextDigest.sha256Hex(utf8: original))
    }
  }

  /// The chunk ranges of a text of `units` with the given passage ends (IOS-SPEC §3.4).
  public static func boundaries(units: [UInt16], passageEnds: [Int32]) -> [Range<Int32>] {
    let n = Int32(units.count)
    guard n > 0 else { return [] }
    // candidate boundaries: passage ends inside the text that do not split a surrogate pair, then the end of the text
    var ends = Set(passageEnds.filter { $0 > 0 && $0 < n }).sorted().filter { e in
      !(UTF16.isLeadSurrogate(units[Int(e) - 1]) && UTF16.isTrailSurrogate(units[Int(e)]))
    }
    ends.append(n)
    var out: [Range<Int32>] = []
    var start: Int32 = 0
    var previous: Int32 = 0  // the last candidate inside the current chunk
    for e in ends {
      if e - start > maxUnits, previous > start {  // adding this passage would overflow: close before it
        out.append(start..<previous)
        start = previous
      }
      if e - start >= targetUnits {
        out.append(start..<e)
        start = e
      }
      previous = e
    }
    if start < n { out.append(start..<n) }
    return out
  }
}

/// A decoded chunk.
struct DecodedChunk {
  let start: Int32
  let end: Int32
  let units: [UInt16]
}

/// The decoded-chunk LRU of one connection, bounded in bytes.
final class DecodedChunkCache {
  private struct Key: Hashable {
    let doc: Int64
    let ord: Int
  }
  private var entries: [Key: (chunk: DecodedChunk, used: UInt64)] = [:]
  private var clock: UInt64 = 0
  private var bytes = 0
  let capacityBytes: Int

  init(capacityBytes: Int) { self.capacityBytes = capacityBytes }

  func get(doc: Int64, ord: Int) -> DecodedChunk? {
    let k = Key(doc: doc, ord: ord)
    guard let e = entries[k] else { return nil }
    clock &+= 1
    entries[k] = (e.chunk, clock)
    return e.chunk
  }

  func put(doc: Int64, ord: Int, _ chunk: DecodedChunk) {
    let size = chunk.units.count * 2
    guard size <= capacityBytes else { return }
    while bytes + size > capacityBytes, let victim = entries.min(by: { $0.value.used < $1.value.used }) {
      bytes -= victim.value.chunk.units.count * 2
      entries[victim.key] = nil
    }
    clock &+= 1
    entries[Key(doc: doc, ord: ord)] = (chunk, clock)
    bytes += size
  }
}

/// The chunk codecs: 'lzfse-utf8' (LZFSE over UTF-8) and 'utf8' (raw UTF-8).
public enum ChunkCodec {
  /// Encodes code units; returns the codec, the stored bytes and the UTF-8 length.
  public static func encode(_ units: ArraySlice<UInt16>) throws -> (codec: String, bytes: [UInt8], utf8Count: Int) {
    let utf8 = Array(String(decoding: units, as: UTF16.self).utf8)
    if utf8.count < ChunkedTextStore.rawBelowBytes { return ("utf8", utf8, utf8.count) }
    var out = [UInt8](repeating: 0, count: utf8.count)
    let n = out.withUnsafeMutableBufferPointer { dst in
      utf8.withUnsafeBufferPointer { src in
        compression_encode_buffer(dst.baseAddress!, dst.count, src.baseAddress!, src.count, nil, COMPRESSION_LZFSE)
      }
    }
    if n == 0 || n >= utf8.count { return ("utf8", utf8, utf8.count) }  // incompressible: keep it raw
    out.removeSubrange(n...)
    return ("lzfse-utf8", out, utf8.count)
  }

  /// Decodes a stored chunk of `units` UTF-16 code units.
  public static func decode(codec: String, _ bytes: [UInt8], units: Int, document: Int64 = 0) throws -> [UInt16] {
    let utf8: [UInt8]
    switch codec {
    case "utf8": utf8 = bytes
    case "lzfse-utf8":
      let capacity = units * 3 + 64
      var out = [UInt8](repeating: 0, count: capacity)
      let n = out.withUnsafeMutableBufferPointer { dst in
        bytes.withUnsafeBufferPointer { src in
          compression_decode_buffer(dst.baseAddress!, dst.count, src.baseAddress!, src.count, nil, COMPRESSION_LZFSE)
        }
      }
      guard n > 0 else { throw TextStoreError(document: document, message: "an LZFSE chunk did not decode") }
      out.removeSubrange(n...)
      utf8 = out
    default: throw TextStoreError(document: document, message: "unknown chunk codec '\(codec)'")
    }
    let decoded = Array(String(decoding: utf8, as: UTF8.self).utf16)
    guard decoded.count == units else {
      throw TextStoreError(document: document, message: "a chunk decoded to \(decoded.count) units, expected \(units)")
    }
    return decoded
  }
}
