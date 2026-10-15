// OWNER: N0
// The text store (IOS-SPEC §3.4): every read of document text goes through `TextStore`, so the engine never names
// `document_text.original` itself (SQLCatalogTests). Offsets are UTF-16 code units (D4). `InlineTextStore` reads the
// reference's layout (the whole original in `document_text`); `ChunkedTextStore` reads the device profile's chunks.

import CryptoKit
import Foundation
import ScrollsContracts

/// Reads document text by UTF-16 offsets.
public protocol TextStore: Sendable {
  /// The code units of `range` (the D4 offset space).
  func utf16(_ doc: DocumentID, _ range: Range<Int32>, on c: Connection) throws -> [UInt16]
  /// The text of `range`.
  func slice(_ doc: DocumentID, _ range: Range<Int32>, on c: Connection) throws -> String
  /// The whole original (reader, export, anchors).
  func fullText(_ doc: DocumentID, on c: Connection) throws -> String
  /// Whether sha256(UTF-8 of the whole original) equals `document_text.original_sha256`.
  func verify(_ doc: DocumentID, on c: Connection) throws -> Bool
}

/// Errors of the text store.
public struct TextStoreError: Error, Sendable, Equatable, CustomStringConvertible {
  public let document: Int64
  public let message: String
  public var description: String { "document \(document): \(message)" }
}

extension TextStore {
  public func slice(_ doc: DocumentID, _ range: Range<Int32>, on c: Connection) throws -> String {
    String(decoding: try utf16(doc, range, on: c), as: UTF16.self)
  }

  public func verify(_ doc: DocumentID, on c: Connection) throws -> Bool {
    guard let expected = try c.prepared(StoreSQL.originalSHA).bindingFirst([.int(doc.rawValue)], { $0.text(0) }) else {
      throw TextStoreError(document: doc.rawValue, message: "has no document_text row")
    }
    return TextDigest.sha256Hex(utf8: try fullText(doc, on: c)) == expected
  }
}

/// The reference layout: `document_text.original` holds the whole decoded original.
public struct InlineTextStore: TextStore {
  public init() {}

  public func utf16(_ doc: DocumentID, _ range: Range<Int32>, on c: Connection) throws -> [UInt16] {
    let s = try c.prepared(StoreSQL.inlineOriginal)
    try s.bind(.int(doc.rawValue))
    defer { _ = try? s.reset() }
    guard let row = try s.step() else { throw TextStoreError(document: doc.rawValue, message: "has no document_text row") }
    let units = row.utf16(0)
    guard range.lowerBound >= 0, Int(range.upperBound) <= units.count else {
      throw TextStoreError(document: doc.rawValue, message: "range \(range) is outside its \(units.count) code units")
    }
    return Array(units[Int(range.lowerBound)..<Int(range.upperBound)])
  }

  public func fullText(_ doc: DocumentID, on c: Connection) throws -> String {
    guard let text = try c.prepared(StoreSQL.inlineOriginal).bindingFirst([.int(doc.rawValue)], { $0.text(0) }) else {
      throw TextStoreError(document: doc.rawValue, message: "has no document_text row")
    }
    return text
  }
}

/// sha256 of text as the reference computes it (`createHash('sha256').update(s)`: UTF-8).
public enum TextDigest {
  public static func sha256Hex(utf8 s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
