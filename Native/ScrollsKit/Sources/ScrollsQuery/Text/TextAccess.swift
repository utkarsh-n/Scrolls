// OWNER: N3
// Passage text and its base string (kwic.mjs documentOriginal / fieldValue / passageBase / passageText). Offsets are UTF-16
// code units into the document's decoded original (field 'body', read through `TextStore` only, IOS-SPEC §1.4) or into
// `document_field.value` (other fields). Originals are immutable per document id, so a process-wide LRU bounded by code
// units is safe (keyed by the database file); on the device profile a passage read decodes only the chunks it covers.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore
import Synchronization

/// Reads passage text by UTF-16 offsets.
public struct TextAccess: Sendable {
  public let store: any TextStore

  public init(store: any TextStore) { self.store = store }

  /// A reader for a connection: the store matching its profile.
  public static func `for`(_ c: Connection) -> TextAccess {
    TextAccess(store: c.profile == .device ? ChunkedTextStore() : InlineTextStore())
  }

  /// The whole base string of a passage field: the original (body) or the field value; nil when there is none.
  public func base(_ c: Connection, doc: Int64, field: String) throws -> [UInt16]? {
    let key = "\(c.path)|\(field == "body" ? "b" : "f:\(field)"):\(doc)"
    if let hit = TextCache.originals.get(key) { return hit.units }
    let units: [UInt16]?
    if field == "body" {
      do {
        units = Array(try store.fullText(DocumentID(rawValue: doc), on: c).utf16)
      } catch is TextStoreError {
        units = nil
      }
    } else {
      units = try c.prepared(ReadSQL.fieldValue).bindingFirst([.int(doc), .text(field)]) { r -> [UInt16]? in
        r.isNull(0) ? nil : Array(r.text(0).utf16)
      } ?? nil
    }
    TextCache.originals.put(key, TextCache.Entry(units: units))
    return units
  }

  /// `passageText`: base.slice(start, end), '' when the document has no text.
  public func passage(_ c: Connection, doc: Int64, field: String, start: Int, end: Int) throws -> [UInt16] {
    if field == "body" && c.profile == .device {
      // the chunked store decodes only the chunks the range covers, through its own per-connection LRU
      let lo = Int32(max(0, start)), hi = Int32(max(start, end))
      return (try? store.utf16(DocumentID(rawValue: doc), lo..<hi, on: c)) ?? []
    }
    guard let b = try base(c, doc: doc, field: field) else { return [] }
    return JSText.slice(b, start, end)
  }
}

/// The process-wide cache of whole originals and field values (kwic.mjs: ≤ 24M units; few, large entries).
enum TextCache {
  struct Entry: Sendable {
    var units: [UInt16]?
    var size: Int { units?.count ?? 0 }
  }

  final class LRU: Sendable {
    private struct State {
      var map: [String: (entry: Entry, tick: UInt64)] = [:]
      var size = 0
      var tick: UInt64 = 0
    }
    private let state = Mutex(State())
    let budget: Int
    init(budget: Int) { self.budget = budget }

    func get(_ key: String) -> Entry? {
      state.withLock { s in
        guard let e = s.map[key] else { return nil }
        s.tick &+= 1
        s.map[key] = (e.entry, s.tick)
        return e.entry
      }
    }

    func put(_ key: String, _ entry: Entry) {
      state.withLock { s in
        s.tick &+= 1
        if let old = s.map[key] { s.size -= old.entry.size }
        s.map[key] = (entry, s.tick)
        s.size += entry.size
        while s.size > budget && s.map.count > 1 {
          guard let victim = s.map.min(by: { $0.value.tick < $1.value.tick })?.key else { break }
          s.size -= s.map[victim]!.entry.size
          s.map[victim] = nil
        }
      }
    }

    func clear() { state.withLock { $0 = State() } }
  }

  static let originals = LRU(budget: 24 * 1024 * 1024)

  /// Drops the cache (a memory warning).
  static func trim() { originals.clear() }
}

extension QueryEngine {
  /// Drops the text caches (AtlasPlatform.trim, a memory warning).
  public static func trimCaches() {
    TextCache.trim()
    Artifacts.trimMemory()
  }
}
