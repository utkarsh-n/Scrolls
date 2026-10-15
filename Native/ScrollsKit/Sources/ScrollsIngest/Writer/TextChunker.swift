// OWNER: N1
// The document_text row of store/document-writer.mjs, in both layouts (IOS-SPEC §3.2 DP-1, §3.4): a reference database
// keeps the whole decoded original inline; a device atlas writes `document_text` with `original = ''` (every other
// column as the reference, `original_sha256` the sha256 of the whole UTF-8 original, the D18 anchor key) and stores the
// text through `ChunkedTextStore.Writer`, cut at body passage ends (chunks close at the first passage end at or after
// 16,384 units, never past 65,536, never inside a surrogate pair). Readers see the same text either way (TextStore), and
// LogicalDump compares the two layouts through the virtual `original` column (DV-11).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Where a document's text goes.
public enum TextChunker {
  /// The chunk ranges an original of `units` code units with these passage ends gets (§3.4).
  public static func chunks(units: [UInt16], passageEnds: [Int]) -> [Range<Int32>] {
    ChunkedTextStore.boundaries(units: units, passageEnds: passageEnds.map { Int32(clamping: $0) })
  }
}

extension DocumentWriter {
  /// Writes `document_text` (and, on a device atlas, the text chunks).
  func writeText(document id: Int64, _ t: CanonicalText, body: Body, _ tx: WriteTx) throws {
    let c = tx.connection
    let sha = TextDigest.sha256Hex(utf8: t.original)
    let chunked = c.profile == .device
    let ins = try c.prepared(IngestSQL.insertText)
    try ins.bind(.int(id), .text(chunked ? "" : t.original), .int(Int64(t.bodyStart ?? 0)),
                 .int(Int64(t.bodyEnd ?? body.units.count)), .text(sha), .text(t.decoder))
    try ins.run()
    if chunked {
      var writer = ChunkedTextStore.Writer()
      let ends = body.passages.map { Int32(clamping: $0.end) }
      _ = try writer.append(document: DocumentID(rawValue: id), original: t.original, passageEnds: ends, on: c)
    }
  }
}
