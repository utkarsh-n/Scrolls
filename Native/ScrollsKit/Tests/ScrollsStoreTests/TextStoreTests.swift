// OWNER: N0
// IOS-SPEC §3.4, §8.4.10 item 2: "the chunk codec round-trips on all Unicode planes". Texts drawn from every plane
// (BMP, SMP, SIP, TIP, SSP, both supplementary private-use planes) are chunked at passage ends and read back by
// passage, by random range and whole; chunk boundaries obey the 16,384 / 65,536 rule and never split a surrogate
// pair; LZFSE carries the large chunks, raw UTF-8 the small ones; inline and chunked stores agree.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsStore
import Testing

@Suite("Text store")
struct TextStoreTests {
  /// Scalars from each plane, avoiding surrogates and noncharacters.
  static let planes: [ClosedRange<UInt32>] = [
    0x20...0x7E, 0xA0...0xD7FF, 0xE000...0xFDCF, 0x1_0000...0x1_FFFD, 0x2_0000...0x2_FFFD, 0x3_0000...0x3_134A,
    0xE_0001...0xE_01EF, 0xF_0000...0xF_FFFD, 0x10_0000...0x10_FFFD,
  ]

  /// A text of about `units` UTF-16 units drawn from all planes, with passage ends after "paragraphs".
  static func text(units: Int, seed: UInt32) -> (String, [Int32]) {
    var r = Fixtures.Random(seed)
    var scalars = String.UnicodeScalarView()
    var ends: [Int32] = []
    var count = 0
    var paragraph = 0
    while count < units {
      let plane = planes[r.next(planes.count)]
      let v = plane.lowerBound + UInt32(r.next(Int(plane.upperBound - plane.lowerBound) + 1))
      guard let s = Unicode.Scalar(v) else { continue }
      scalars.append(s)
      count += s.utf16.count
      paragraph += 1
      if paragraph > 200 + r.next(9000) {
        scalars.append("\n")
        count += 1
        ends.append(Int32(count))
        paragraph = 0
      }
    }
    return (String(scalars), ends)
  }

  /// Writes `original` as a chunked document of a fresh device atlas; returns the connection.
  static func chunkedAtlas(_ docs: [(String, [Int32])]) throws -> (Connection, [TextStorageRow]) {
    let c = try Connection(path: try Fixtures.atlas(.device), mode: .readWrite, profile: .device)
    try c.exec("""
      INSERT INTO source_adapter (id, version, label, access) VALUES ('file.txt', '1', 'Text', 'local-file');
      INSERT INTO collection (id, corpus_id, adapter_id, slug, name, domain, modality, unit, sampling, created_at)
        VALUES (1, 1, 'file.txt', 'c', 'C', 'imported', 'text', 'tokens', 'user', 't');
      INSERT INTO import_batch (id, collection_id, adapter_id, adapter_version, format, status, created_at)
        VALUES (1, 1, 'file.txt', '1', 'txt', 'committed', 't');
      """)
    var rows: [TextStorageRow] = []
    try c.transaction(.immediate) {
      var writer = ChunkedTextStore.Writer()
      for (k, (original, ends)) in docs.enumerated() {
        let id = Int64(k + 1)
        let doc = try c.prepared(dynamic: "INSERT INTO document (id, collection_id, import_batch_id, ext_id, kind, chrono_status, original_meta_json, created_at) VALUES (?, 1, 1, ?, 'book', 'undated', '{}', 't')")
        try doc.bind(.int(id), .text("d\(id)"))
        try doc.run()
        let dt = try c.prepared(dynamic: "INSERT INTO document_text (document_id, original, body_start, body_end, original_sha256, decoder) VALUES (?, '', 0, ?, ?, 'utf-8')")
        try dt.bind(.int(id), .int(Int64(original.utf16.count)), .text(TextDigest.sha256Hex(utf8: original)))
        try dt.run()
        rows.append(try writer.append(document: DocumentID(rawValue: id), original: original, passageEnds: ends, on: c))
      }
    }
    return (c, rows)
  }

  @Test("all Unicode planes round-trip through the chunk codec: by passage, by random range, whole, and verified")
  func allPlanesRoundTrip() throws {
    let docs = [Self.text(units: 300_000, seed: 1), Self.text(units: 70_000, seed: 2), Self.text(units: 900, seed: 3)]
    let (c, rows) = try Self.chunkedAtlas(docs)
    let store = ChunkedTextStore()
    var r = Fixtures.Random(99)
    var checked = 0
    for (k, (original, ends)) in docs.enumerated() {
      let doc = DocumentID(rawValue: Int64(k + 1))
      let units = Array(original.utf16)
      #expect(try store.fullText(doc, on: c) == original)
      #expect(try store.verify(doc, on: c))
      var start: Int32 = 0
      for e in ends + [Int32(units.count)] where e > start {
        #expect(try store.utf16(doc, start..<e, on: c) == Array(units[Int(start)..<Int(e)]))
        start = e
        checked += 1
      }
      for _ in 0..<200 {
        let a = r.next(units.count + 1), b = r.next(units.count + 1)
        let range = Int32(min(a, b))..<Int32(max(a, b))
        #expect(try store.utf16(doc, range, on: c) == Array(units[Int(range.lowerBound)..<Int(range.upperBound)]))
        checked += 1
      }
      #expect(rows[k].utf16Len == units.count && rows[k].utf8Len == original.utf8.count)
    }
    let codecs = try c.prepared(dynamic: "SELECT codec, count(*) FROM text_chunk GROUP BY codec ORDER BY codec").all { ($0.text(0), $0.int(1)) }
    #expect(codecs.contains { $0.0 == "lzfse-utf8" } && codecs.contains { $0.0 == "utf8" }, "\(codecs)")
    #expect(checked > 600)
    // every plane is present in the texts
    let used = Set(docs.flatMap { $0.0.unicodeScalars.map { $0.value >> 16 } })
    #expect(used.isSuperset(of: [0, 1, 2, 3, 14, 15, 16]))
  }

  @Test("chunk boundaries: passage ends, ≥ 16,384 units except the last, ≤ 65,536 unless one passage is longer, no split pair")
  func boundaries() throws {
    for seed in UInt32(1)...20 {
      let (text, ends) = Self.text(units: 150_000 + Int(seed) * 7_919, seed: seed)
      let units = Array(text.utf16)
      let chunks = ChunkedTextStore.boundaries(units: units, passageEnds: ends)
      #expect(chunks.first?.lowerBound == 0 && chunks.last?.upperBound == Int32(units.count))
      for (i, ch) in chunks.enumerated() {
        if i > 0 { #expect(ch.lowerBound == chunks[i - 1].upperBound) }
        if i < chunks.count - 1 {
          #expect(ends.contains(ch.upperBound), "chunk \(i) ends inside a passage")
          let passages = ends.filter { $0 > ch.lowerBound && $0 <= ch.upperBound }
          #expect(ch.count >= Int(ChunkedTextStore.targetUnits) || ch.count + nextPassageLength(after: ch.upperBound, ends, units.count) > Int(ChunkedTextStore.maxUnits),
                  "chunk \(i) closed early at \(ch.count) units")
          #expect(ch.count <= Int(ChunkedTextStore.maxUnits) || passages.count == 1, "chunk \(i) has \(ch.count) units and \(passages.count) passages")
        }
        #expect(!(UTF16.isLeadSurrogate(units[Int(ch.upperBound) - 1]) && ch.upperBound < Int32(units.count) && UTF16.isTrailSurrogate(units[Int(ch.upperBound)])))
      }
    }
    // a single passage longer than 65,536 units is its own chunk (the short passage before it closes early)
    let long = [UInt16](repeating: 0x61, count: 200_000)
    #expect(ChunkedTextStore.boundaries(units: long, passageEnds: [10, 150_000, 150_010]) == [0..<10, 10..<150_000, 150_000..<200_000])
    // a passage end inside a surrogate pair is never a boundary
    let pairs = Array(String(repeating: "😀", count: 20_000).utf16)
    #expect(ChunkedTextStore.boundaries(units: pairs, passageEnds: [16_385, 16_386]) == [0..<16_386, 16_386..<40_000])
  }

  func nextPassageLength(after end: Int32, _ ends: [Int32], _ total: Int) -> Int {
    Int((ends.first { $0 > end } ?? Int32(total)) - end)
  }

  @Test("inline and chunked stores read the same text; ranges outside the text are refused")
  func inlineEqualsChunked() throws {
    let (text, ends) = Self.text(units: 40_000, seed: 7)
    let (c, _) = try Self.chunkedAtlas([(text, ends)])
    try c.exec("INSERT INTO document (id, collection_id, import_batch_id, ext_id, kind, chrono_status, original_meta_json, created_at) VALUES (2, 1, 1, 'inline', 'book', 'undated', '{}', 't')")
    let ins = try c.prepared(dynamic: "INSERT INTO document_text (document_id, original, body_start, body_end, original_sha256, decoder) VALUES (2, ?, 0, 0, ?, 'utf-8')")
    try ins.bind(.text(text), .text(TextDigest.sha256Hex(utf8: text)))
    try ins.run()
    let chunked = ChunkedTextStore(), inline = InlineTextStore()
    for range in [Int32(0)..<10, 100..<30_000, 39_000..<Int32(text.utf16.count)] {
      #expect(try chunked.utf16(DocumentID(rawValue: 1), range, on: c) == inline.utf16(DocumentID(rawValue: 2), range, on: c))
      #expect(try chunked.slice(DocumentID(rawValue: 1), range, on: c) == chunked.slice(DocumentID(rawValue: 2), range, on: c))
    }
    #expect(try inline.verify(DocumentID(rawValue: 2), on: c))
    #expect(throws: TextStoreError.self) { try chunked.utf16(DocumentID(rawValue: 1), 0..<Int32(text.utf16.count + 1), on: c) }
    #expect(throws: TextStoreError.self) { try inline.utf16(DocumentID(rawValue: 2), -1..<3, on: c) }
    #expect(throws: TextStoreError.self) { try inline.fullText(DocumentID(rawValue: 9), on: c) }
  }

  @Test("text chunks are immutable; a corrupted chunk is detected, never returned")
  func corruption() throws {
    let (text, ends) = Self.text(units: 50_000, seed: 11)
    let (c, _) = try Self.chunkedAtlas([(text, ends)])
    #expect(throws: StoreError.self) { try c.exec("UPDATE text_chunk SET codec = 'utf8'") }
    #expect(throws: TextStoreError.self) { try ChunkCodec.decode(codec: "lzfse-utf8", [1, 2, 3, 4], units: 100) }
    #expect(throws: TextStoreError.self) { try ChunkCodec.decode(codec: "utf8", Array("abc".utf8), units: 4) }
    #expect(throws: TextStoreError.self) { try ChunkCodec.decode(codec: "zstd", [], units: 0) }
  }
}
