// OWNER: N3
// Snapshot storage (routes/exports.mjs `storeSnapshot`, GET /api/snapshots/:file; SPEC §7.3): a PNG and/or SVG of a view
// rendered by the app (DisplayListCanvas / SVGWriter), stored under Documents/Exports/snapshots/ and, for a saved view,
// its SVG in `saved_view.snapshot_svg`. A snapshot of synthetic material must carry the SYNTHETIC stamp: an SVG for a
// synthetic view (or one flagged synthetic) without it is refused (honesty rule 1). A PNG's stamp cannot be read back
// here; the renderer adds it.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Stored view snapshots.
public enum Snapshots {
  static let maxPNG = 20 * 1024 * 1024
  static let maxSVG = 5 * 1024 * 1024
  static let pngSignature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
  static let types = ["png": "image/png", "svg": "image/svg+xml; charset=utf-8"]

  /// What a request will store, validated against the atlas (a read).
  public struct Plan: Sendable {
    public var corpus: String?
    public var viewSlug: String?
    public var png: Data?
    /// The base64 text of the PNG data URL (the file name hashes it, as the reference does).
    public var pngBase64: String?
    public var svg: String?
  }

  static func bad(_ message: String, field: String) -> ScrollsError {
    ScrollsError.badRequest(.validation, message, detail: .object(["field": .string(field)]))
  }

  /// Validates a request: a PNG data URL and/or an SVG document; the view, when named, must exist.
  public static func plan(_ c: Connection, _ r: SnapshotCreateRequest) throws -> Plan {
    if r.png == nil && r.svg == nil {
      throw ScrollsError.badRequest(.validation, "A snapshot needs a PNG data URL or an SVG document.",
                                    detail: .object(["fields": .array(["png", "svg"])]))
    }
    var p = Plan()
    var synthetic = r.synthetic == true
    if let view = r.view {
      guard let row = try c.prepared(ExportSQL.savedView).bindingFirst([.text(view)], { ($0.text(0), $0.text(1)) }) else {
        throw ScrollsError(code: .notFound, message: "No saved view '\(view)'.", status: 404)
      }
      p.viewSlug = row.0
      p.corpus = (try? JSONValue.parse(row.1))?["corpus"]?.stringValue
      if let corpus = p.corpus, try c.prepared(ExportSQL.viewCorpusSynthetic).bindingFirst([.text(corpus)], { $0.int(0) }) == 1 {
        synthetic = true
      }
    }
    if let png = r.png {
      let prefix = "data:image/png;base64,"
      guard JSString.hasPrefix(png, prefix) else { throw bad("png must be a data:image/png;base64 URL.", field: "png") }
      let b64 = String(png.dropFirst(prefix.count))
      let compact = b64.filter { !$0.isWhitespace }
      guard compact.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "/" || $0 == "=") }),
        let bytes = Data(base64Encoded: compact, options: .ignoreUnknownCharacters)
      else { throw bad("png must be a data:image/png;base64 URL.", field: "png") }
      if bytes.count > maxPNG { throw bad("The PNG is larger than 20 MB.", field: "png") }
      guard Array(bytes.prefix(8)) == pngSignature else { throw bad("The png data is not a PNG image.", field: "png") }
      p.png = bytes
      p.pngBase64 = b64
    }
    if let svg = r.svg {
      if svg.utf8.count > maxSVG { throw bad("The SVG is larger than 5 MB.", field: "svg") }
      guard isSVGDocument(svg) else { throw bad("svg must be an SVG document.", field: "svg") }
      if synthetic && !svg.contains("SYNTHETIC") {
        throw ScrollsError.badRequest(.validation, "A snapshot of synthetic data must carry the SYNTHETIC stamp.",
                                      hint: "Render the snapshot with its SYNTHETIC stamp (the display list adds it whenever synthetic items are visible).",
                                      detail: .object(["field": .string("svg")]))
      }
      p.svg = svg
    }
    return p
  }

  /// `/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i`.
  static func isSVGDocument(_ s: String) -> Bool {
    var rest = Substring(s).drop { $0.isWhitespace }
    if Fold.asciiLowercased(String(rest.prefix(5))) == "<?xml", let close = rest.firstIndex(of: ">") {
      rest = rest[rest.index(after: close)...].drop { $0.isWhitespace }
    }
    let head = Fold.asciiLowercased(String(rest.prefix(5)))  // ASCII-only, as /i on an ASCII pattern
    guard head.hasPrefix("<svg"), head.count == 5 else { return false }
    let c = head.last!
    return c == ">" || c.isWhitespace
  }

  /// Writes the planned files into `dir` (atomically) and answers `{file, url}`; the first file is the PNG when there
  /// is one.
  public static func write(_ p: Plan, dir: URL, dataVersion: Int) throws -> (response: SnapshotCreateResponse, files: [String]) {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let base = "scrolls-\(p.corpus ?? "view")-v\(dataVersion)"
    var files: [String] = []
    if let png = p.png, let b64 = p.pngBase64 {
      let file = "\(base)-\(IDs.shortHash(b64, length: 8)).png"
      try png.write(to: dir.appendingPathComponent(file), options: .atomic)
      files.append(file)
    }
    if let svg = p.svg {
      let file = "\(base)-\(IDs.shortHash(svg, length: 8)).svg"
      try Data(svg.utf8).write(to: dir.appendingPathComponent(file), options: .atomic)
      files.append(file)
    }
    return (SnapshotCreateResponse(file: files[0], url: "/api/snapshots/\(files[0])"), files)
  }

  /// Keeps a saved view's SVG snapshot in `saved_view.snapshot_svg`.
  public static func saveSVG(_ tx: WriteTx, slug: String, svg: String) throws {
    let s = try tx.connection.prepared(ExportSQL.saveSnapshotSVG)
    try s.bind([.text(svg), .text(slug)])
    try s.run()
  }

  /// A stored snapshot by file name (`[A-Za-z0-9][A-Za-z0-9._-]{0,120}.(png|svg)`); 404 for anything else.
  public static func read(dir: URL, file: String) throws -> SnapshotResponse {
    let u = Array(file.utf8)
    func ok(_ b: UInt8, first: Bool) -> Bool {
      let alnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
      return first ? alnum : alnum || b == 0x2E || b == 0x5F || b == 0x2D
    }
    let ext = file.hasSuffix(".png") ? "png" : file.hasSuffix(".svg") ? "svg" : nil
    let stem = u.dropLast(4)
    guard let ext, !stem.isEmpty, stem.count <= 121, ok(stem.first!, first: true), stem.allSatisfy({ ok($0, first: false) }),
      let data = try? Data(contentsOf: dir.appendingPathComponent(file))
    else { throw ScrollsError(code: .notFound, message: "No snapshot \(file).", status: 404) }
    return SnapshotResponse(contentType: types[ext]!, data: data)
  }
}
