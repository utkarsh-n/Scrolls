// OWNER: N6
// Port of server/provenance/anchors.mjs (SPEC D18): durable anchors for annotations and evidence spans,
//   {doc_id, sha256, field, start, end, quote, prefix (≤ 32), suffix (≤ 32)}.
// Offsets are UTF-16 code units (D4) into the document text (field 'body', read through `TextStore`) or into
// `document_field.value` (any other field), never passage-relative, so re-segmentation or an ICU upgrade cannot orphan
// an interpretation. Resolution order: exact (same text, same offsets) → offsets (quote still at its offsets) → quote
// (unique verbatim match) → context (several matches, chosen by prefix/suffix agreement) → normalized (whitespace and
// line endings collapsed) → orphaned (nil; reported, never silently dropped). Strings are handled as UTF-16 arrays so
// `indexOf`, `slice` and lengths are JavaScript's.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A D18 anchor as the reference stores it in `anchor_json`.
public struct AnchorValue: Sendable, Equatable {
  public var docId: Int64?
  public var sha256: String
  public var field: String
  public var start: Int
  public var end: Int
  public var quote: String
  public var prefix: String
  public var suffix: String

  /// `JSON.stringify(anchor)` in the reference's key order (doc_id, sha256, field, start, end, quote, prefix, suffix).
  public var jsonText: String {
    let parts: [(String, String)] = [
      ("doc_id", docId.map(String.init) ?? "null"), ("sha256", CanonicalJSON.quote(sha256)), ("field", CanonicalJSON.quote(field)),
      ("start", String(start)), ("end", String(end)), ("quote", CanonicalJSON.quote(quote)),
      ("prefix", CanonicalJSON.quote(prefix)), ("suffix", CanonicalJSON.quote(suffix)),
    ]
    return "{" + parts.map { "\(CanonicalJSON.quote($0.0)):\($0.1)" }.joined(separator: ",") + "}"
  }

  /// The anchor as a JSON value (what a response carries).
  public var json: JSONValue {
    .object([
      "doc_id": docId.map { .number(Double($0)) } ?? .null, "sha256": .string(sha256), "field": .string(field),
      "start": .number(Double(start)), "end": .number(Double(end)), "quote": .string(quote), "prefix": .string(prefix),
      "suffix": .string(suffix),
    ])
  }

  /// The contract type.
  public var contract: Anchor {
    Anchor(docId: DocumentID(rawValue: docId ?? 0), sha256: sha256, field: field, start: start, end: end, quote: quote,
           prefix: prefix, suffix: suffix)
  }
}

/// A stored or sent anchor whose members may be missing (`anchor?.quote` …).
public struct LooseAnchor: Sendable, Equatable {
  public var docId: Int?
  public var sha256: String?
  public var field: String?
  public var start: Int?
  public var end: Int?
  public var quote: String?
  public var prefix: String?
  public var suffix: String?

  public init(docId: Int? = nil, sha256: String? = nil, field: String? = nil, start: Int? = nil, end: Int? = nil,
              quote: String? = nil, prefix: String? = nil, suffix: String? = nil) {
    self.docId = docId
    self.sha256 = sha256
    self.field = field
    self.start = start
    self.end = end
    self.quote = quote
    self.prefix = prefix
    self.suffix = suffix
  }

  /// From a parsed `anchor_json` or a request's anchor object (JavaScript property reads: wrong types read as absent).
  public init(_ v: JSONValue) {
    self.init(docId: v["doc_id"]?.integer, sha256: v["sha256"]?.stringValue, field: v["field"]?.stringValue,
              start: v["start"]?.integer, end: v["end"]?.integer, quote: v["quote"]?.stringValue,
              prefix: v["prefix"]?.stringValue, suffix: v["suffix"]?.stringValue)
  }

  public init(_ a: AnchorValue) {
    self.init(docId: a.docId.map { Int($0) }, sha256: a.sha256, field: a.field, start: a.start, end: a.end, quote: a.quote,
              prefix: a.prefix, suffix: a.suffix)
  }
}

/// The text an anchor's offsets index, with its sha256.
public struct FieldText: Sendable {
  public let units: [UInt16]
  public let sha: String
  public var string: String { String(decoding: units, as: UTF16.self) }
}

/// The passage that holds a span.
public struct PassageSpan: Sendable, Equatable {
  public let id: Int64
  public let startOff: Int
  public let endOff: Int
  /// The span crosses a passage boundary: this is the passage containing its start.
  public let split: Bool
}

/// How an anchor was found again.
public struct AnchorResolution: Sendable, Equatable {
  public let start: Int
  public let end: Int
  /// 'exact' | 'offsets' | 'quote' | 'context' | 'normalized'
  public let method: String
  public let ambiguous: Bool
}

public enum Anchors {
  /// Characters of context kept on each side of an anchor.
  public static let context = 32

  /// `sha256(s)`: hex of the UTF-8 bytes (document_text.original_sha256 uses the same rule).
  public static func sha256(_ units: [UInt16]) -> String { TextDigest.sha256Hex(utf8: String(decoding: units, as: UTF16.self)) }

  /// `makeAnchor(original, {field, start, end}, {docId, sha})`. Throws when the span is empty or outside the text.
  public static func make(_ original: [UInt16], field: String, start: Int, end: Int, docId: Int64?, sha: String?) throws -> AnchorValue {
    guard start >= 0, end <= original.count, start < end else {
      throw ScrollsError(code: .range, message: "makeAnchor: span \(start)–\(end) is empty or outside the text (length \(original.count))",
                         status: 500)
    }
    return AnchorValue(
      docId: docId, sha256: sha ?? sha256(original), field: field, start: start, end: end,
      quote: string(original, start, end),
      prefix: string(original, max(0, start - context), start),
      suffix: string(original, end, min(original.count, end + context)))
  }

  // MARK: resolution

  /// `resolveAnchor(original, anchor, {sha})`: re-locate an anchor in a (possibly changed) text; nil when the quoted
  /// words cannot be found (the anchor is orphaned).
  public static func resolve(_ original: [UInt16], _ anchor: LooseAnchor, sha: String? = nil) -> AnchorResolution? {
    guard let quoteString = anchor.quote, !quoteString.isEmpty else { return nil }
    let quote = Array(quoteString.utf16)
    if let start = anchor.start, let end = anchor.end, jsSlice(original, start, end) == quote {
      let same = (anchor.sha256.map { !$0.isEmpty } ?? false) && (sha ?? sha256(original)) == anchor.sha256
      return AnchorResolution(start: start, end: end, method: same ? "exact" : "offsets", ambiguous: false)
    }
    let hits = allIndexes(original, quote)
    if hits.count == 1 {
      return AnchorResolution(start: hits[0], end: hits[0] + quote.count, method: "quote", ambiguous: false)
    }
    if hits.count > 1 {
      let b = bestByContext(original, hits, anchor, quote.count)!
      return AnchorResolution(start: b.start, end: b.start + quote.count, method: "context", ambiguous: b.tie || b.score == 0)
    }
    // whitespace and line endings may differ (CRLF → LF, re-wrapped lines, NBSP)
    let q = collapseWhitespace(JSString.trim(quoteString).utf16.map { $0 }).text
    if q.isEmpty { return nil }
    let norm = collapseWhitespace(original)
    let nHits = allIndexes(norm.text, q)
    if nHits.isEmpty { return nil }
    func toOrig(_ i: Int) -> (start: Int, end: Int) { (norm.map[i], norm.map[i + q.count - 1] + 1) }
    if nHits.count == 1 {
      let r = toOrig(nHits[0])
      return AnchorResolution(start: r.start, end: r.end, method: "normalized", ambiguous: false)
    }
    let mapped = nHits.map { norm.map[$0] }
    let b = bestByContext(original, mapped, anchor, quote.count)!
    let i = nHits[mapped.firstIndex(of: b.start)!]
    let r = toOrig(i)
    return AnchorResolution(start: r.start, end: r.end, method: "normalized", ambiguous: b.tie || b.score == 0)
  }

  struct Best {
    var start: Int
    var score: Int
    var dist: Int
    var tie: Bool
  }

  /// The candidate start whose surroundings agree best with the anchor's prefix/suffix (ties: nearest old start).
  static func bestByContext(_ text: [UInt16], _ candidates: [Int], _ anchor: LooseAnchor, _ len: Int) -> Best? {
    var best: Best?
    let prefix = Array((anchor.prefix ?? "").utf16), suffix = Array((anchor.suffix ?? "").utf16)
    for c in candidates {
      let score = commonSuffix(jsSlice(text, max(0, c - context), c), prefix)
        + commonPrefix(jsSlice(text, c + len, c + len + context), suffix)
      let dist = abs(c - (anchor.start ?? 0))
      if best == nil || score > best!.score || (score == best!.score && dist < best!.dist) {
        best = Best(start: c, score: score, dist: dist, tie: false)
      } else if score == best!.score && dist == best!.dist {
        best!.tie = true
      }
    }
    return best
  }

  static func commonSuffix(_ a: [UInt16], _ b: [UInt16]) -> Int {
    var n = 0
    while n < a.count && n < b.count && a[a.count - 1 - n] == b[b.count - 1 - n] { n += 1 }
    return n
  }

  static func commonPrefix(_ a: [UInt16], _ b: [UInt16]) -> Int {
    var n = 0
    while n < a.count && n < b.count && a[n] == b[n] { n += 1 }
    return n
  }

  /// Every start of `needle` in `hay` (overlapping), as `indexOf` from i + 1.
  static func allIndexes(_ hay: [UInt16], _ needle: [UInt16]) -> [Int] {
    var out: [Int] = []
    guard !needle.isEmpty, needle.count <= hay.count else { return out }
    let first = needle[0], n = needle.count
    var i = 0
    let last = hay.count - n
    hay.withUnsafeBufferPointer { h in
      needle.withUnsafeBufferPointer { nd in
        while i <= last {
          if h[i] == first {
            var k = 1
            while k < n && h[i + k] == nd[k] { k += 1 }
            if k == n { out.append(i) }
          }
          i += 1
        }
      }
    }
    return out
  }

  /// Collapses every whitespace run to one space; `map[i]` = the original index of normalized unit i.
  static func collapseWhitespace(_ s: [UInt16]) -> (text: [UInt16], map: [Int]) {
    var out: [UInt16] = []
    var map: [Int] = []
    out.reserveCapacity(s.count)
    map.reserveCapacity(s.count)
    var prevSpace = false
    for (i, c) in s.enumerated() {
      if JSString.isWhitespace(c) {
        if !prevSpace {
          out.append(0x20)
          map.append(i)
        }
        prevSpace = true
      } else {
        out.append(c)
        map.append(i)
        prevSpace = false
      }
    }
    return (out, map)
  }

  /// `s.slice(start, end)` with JavaScript's negative and out-of-range rules.
  public static func jsSlice(_ s: [UInt16], _ start: Int, _ end: Int? = nil) -> [UInt16] {
    let len = s.count
    func clamp(_ x: Int) -> Int { x < 0 ? max(0, len + x) : min(x, len) }
    let from = clamp(start), to = end.map(clamp) ?? len
    return from < to ? Array(s[from..<to]) : []
  }

  static func string(_ s: [UInt16], _ start: Int, _ end: Int) -> String {
    String(decoding: jsSlice(s, start, end), as: UTF16.self)
  }

  // MARK: texts and passages

  /// `loadFieldText`: the document text for 'body' (through the text store; its stored sha256), else the field value.
  public static func loadFieldText(_ c: Connection, text: any TextStore, doc: Int64, field: String?) throws -> FieldText? {
    if field == "body" {
      guard let sha = try c.prepared(ProvenanceSQL.textSha).bindingFirst([.int(doc)], { $0.text(0) }) else { return nil }
      let full = try text.fullText(DocumentID(rawValue: doc), on: c)
      return FieldText(units: Array(full.utf16), sha: sha)
    }
    guard let field else { return nil }
    guard let value = try c.prepared(ProvenanceSQL.fieldValue).bindingFirst([.int(doc), .text(field)], { $0.text(0) }) else {
      return nil
    }
    let units = Array(value.utf16)
    return FieldText(units: units, sha: sha256(units))
  }

  /// `passageFor`: the passage of a document field that contains [start, end); when none does (the span crosses a
  /// passage boundary), the passage containing `start`, with `split`.
  public static func passageFor(_ c: Connection, doc: Int64, field: String, start: Int, end: Int) throws -> PassageSpan? {
    if let p = try c.prepared(ProvenanceSQL.passageInside).bindingFirst(
      [.int(doc), .text(field), .int(Int64(start)), .int(Int64(end))], { ($0.int(0), Int($0.int(1)), Int($0.int(2))) })
    {
      return PassageSpan(id: p.0, startOff: p.1, endOff: p.2, split: false)
    }
    if let p = try c.prepared(ProvenanceSQL.passageFirst).bindingFirst(
      [.int(doc), .text(field), .int(Int64(start)), .int(Int64(start))], { ($0.int(0), Int($0.int(1)), Int($0.int(2))) })
    {
      return PassageSpan(id: p.0, startOff: p.1, endOff: p.2, split: true)
    }
    return nil
  }

  /// A passage an anchor must stay inside (`checkAnchor`'s `passage`).
  public struct PassageBounds: Sendable, Equatable {
    public let id: Int64
    public let documentId: Int64
    public let field: String
    public let startOff: Int
    public let endOff: Int
    public init(id: Int64, documentId: Int64, field: String, startOff: Int, endOff: Int) {
      self.id = id
      self.documentId = documentId
      self.field = field
      self.startOff = startOff
      self.endOff = endOff
    }
  }

  /// `checkAnchor`: check an anchor a client sent and return the server's anchor (prefix/suffix recomputed). A stale
  /// anchor (other text version, offsets that do not hold) is re-located by its quote; one that cannot be found is
  /// refused (400 E_VALIDATION, detail.field 'anchor'). `relocated` is the resolution method when offsets changed.
  public static func check(_ c: Connection, text: any TextStore, input: JSONValue?, docId: Int64?,
                           passage: PassageBounds?) throws -> (anchor: AnchorValue, relocated: String?) {
    guard let input, input.objectValue != nil else {
      throw ProvenanceError.anchor("An anchor is required.", hint: "Select the words the note is about.")
    }
    let fieldValue = input["field"].nonNull ?? .string("body")
    let field = fieldValue.stringValue
    guard let field, Vocab.passageFields.contains(field) else {
      throw ProvenanceError.anchor(
        "Anchor field '\(jsString(fieldValue))' is not one of \(Vocab.passageFields.joined(separator: ", ")).")
    }
    let doc: Int64
    if let d = input["doc_id"]?.integer { doc = Int64(d) } else if let docId { doc = docId } else {
      throw ProvenanceError.anchor("The anchor needs doc_id.")
    }
    if let docId, doc != docId {
      throw ProvenanceError.anchor("The anchor names document \(doc), but the target belongs to document \(docId).",
                                   detail: [("reason", "doc_mismatch")])
    }
    guard let quote = input["quote"]?.stringValue, !quote.isEmpty else {
      throw ProvenanceError.anchor("The anchor needs the quoted words (quote).", hint: "Select the words the note is about.")
    }
    _ = quote
    guard let loaded = try loadFieldText(c, text: text, doc: doc, field: field) else {
      throw ProvenanceError.anchor("Document \(doc) has no '\(field)' text to anchor to.", detail: [("reason", "no_text")])
    }
    var loose = LooseAnchor(input)
    loose.field = field
    guard let r = resolve(loaded.units, loose, sha: loaded.sha) else {
      throw ProvenanceError.anchor(
        "The quoted words are not in document \(doc) (\(field)).",
        hint: "Offsets are UTF-16 code units into the document text (D4); copy the passage anchor and select again.",
        detail: [("reason", "not_found")])
    }
    if r.ambiguous {
      throw ProvenanceError.anchor(
        "The quoted words occur more than once and the offsets do not say which.",
        hint: "Send start/end as offsets into the document text (the passage anchor gives the passage start).",
        detail: [("reason", "ambiguous")])
    }
    if let p = passage, p.field != field || r.start < p.startOff || r.end > p.endOff {
      throw ProvenanceError.anchor(
        "The anchored words (\(r.start)–\(r.end)) lie outside passage \(p.id) (\(p.startOff)–\(p.endOff)).",
        hint: "Offsets index the document text, not the passage text; add the passage start.",
        detail: [("reason", "outside_passage")])
    }
    let anchor = try make(loaded.units, field: field, start: r.start, end: r.end, docId: doc, sha: loaded.sha)
    return (anchor, r.method == "exact" || r.method == "offsets" ? nil : r.method)
  }

  /// `String(v)` of a JSON value as a template literal would print it.
  static func jsString(_ v: JSONValue) -> String {
    switch v {
    case .null: "null"
    case .bool(let b): b ? "true" : "false"
    case .number(let n): JSNumber.format(n)
    case .string(let s): s
    case .array(let a): a.map { $0.isNull ? "" : jsString($0) }.joined(separator: ",")
    case .object: "[object Object]"
    }
  }

  // MARK: re-anchoring after re-segmentation (or a changed decoding)

  /// What `reanchorDocument` did.
  public struct ReanchorReport: Sendable, Equatable {
    public struct Moved: Sendable, Equatable {
      public let id: Int64
      public let from: String
      public let to: String
      public let passage: Int64
      public let method: String
      public let split: Bool
    }
    public struct Orphan: Sendable, Equatable {
      public let id: Int64
      /// "passage:901" for an annotation, the relationship id for evidence.
      public let target: String
      public let quote: String?
      public let reason: String
    }
    public var document: Int64
    public var annotationsChecked = 0, annotationsUnchanged = 0
    public var annotationsReanchored: [Moved] = []
    public var annotationsOrphaned: [Orphan] = []
    public var evidenceChecked = 0, evidenceUnchanged = 0
    public var evidenceReanchored: [Moved] = []
    public var evidenceOrphaned: [Orphan] = []
    /// Relationship endpoints that name a passage that no longer exists (endpoints are immutable; reported only).
    public var missingEndpoints: [(relationship: Int64, end: String, passage: Int64)] = []

    public static func == (a: ReanchorReport, b: ReanchorReport) -> Bool {
      a.document == b.document && a.annotationsChecked == b.annotationsChecked && a.annotationsUnchanged == b.annotationsUnchanged
        && a.annotationsReanchored == b.annotationsReanchored && a.annotationsOrphaned == b.annotationsOrphaned
        && a.evidenceChecked == b.evidenceChecked && a.evidenceUnchanged == b.evidenceUnchanged
        && a.evidenceReanchored == b.evidenceReanchored && a.evidenceOrphaned == b.evidenceOrphaned
        && a.missingEndpoints.map { "\($0.relationship):\($0.end):\($0.passage)" }
          == b.missingEndpoints.map { "\($0.relationship):\($0.end):\($0.passage)" }
    }
  }

  /// `reanchorDocument(db, documentId)`: re-anchor every annotation and evidence span of a document to the passages it
  /// has now. Anchors are re-located by (sha256, offsets, quote); rows whose words cannot be found are reported as
  /// orphaned and left untouched — nothing is deleted. Runs inside the caller's write transaction.
  public static func reanchorDocument(_ c: Connection, text: any TextStore, document: Int64) throws -> ReanchorReport {
    var report = ReanchorReport(document: document)
    var cache: [String: FieldText?] = [:]
    func textOf(_ field: String) throws -> FieldText? {
      if let hit = cache[field] { return hit }
      let t = try loadFieldText(c, text: text, doc: document, field: field)
      cache[field] = t
      return t
    }
    struct Located {
      let r: AnchorResolution
      let passage: PassageSpan?
      let moved: Bool
      let anchor: AnchorValue?
      let original: LooseAnchor
    }
    func locate(_ a: LooseAnchor) throws -> Located? {
      let field = a.field ?? "body"
      guard let t = try textOf(field), let r = resolve(t.units, a, sha: t.sha) else { return nil }
      let p = try passageFor(c, doc: document, field: field, start: r.start, end: r.end)
      let moved = r.start != a.start || r.end != a.end || t.sha != a.sha256
      let next = moved ? try make(t.units, field: field, start: r.start, end: r.end, docId: document, sha: t.sha) : nil
      return Located(r: r, passage: p, moved: moved, anchor: next, original: a)
    }

    let anns = try c.prepared(ProvenanceSQL.annotationsWithAnchorOfDoc).bindingFirstAll([.int(document)]) {
      (id: $0.int(0), type: $0.text(1), ref: $0.text(2), anchor: $0.text(3))
    }
    for a in anns {
      report.annotationsChecked += 1
      let parsed = try? JSONValue.parse(a.anchor)
      let anchor = parsed.flatMap { $0.objectValue == nil ? nil : LooseAnchor($0) }
      let loc = try anchor.flatMap(locate)
      guard let loc, let passage = loc.passage else {
        report.annotationsOrphaned.append(.init(id: a.id, target: "\(a.type):\(a.ref)", quote: anchor?.quote,
          reason: loc != nil ? "no passage covers the words" : "the quoted words are not in the text"))
        continue
      }
      let newRef = a.type == "passage" ? String(passage.id) : a.ref
      if newRef == a.ref && !loc.moved {
        report.annotationsUnchanged += 1
        continue
      }
      let json = loc.anchor?.jsonText ?? a.anchor
      let up = try c.prepared(ProvenanceSQL.updateAnnotationAnchor)
      try up.bind(.text(newRef), .text(json), .int(a.id))
      try up.run()
      report.annotationsReanchored.append(.init(id: a.id, from: a.ref, to: newRef, passage: passage.id, method: loc.r.method,
                                                split: passage.split))
    }

    let evs = try c.prepared(ProvenanceSQL.evidenceWithAnchorOfDoc).bindingFirstAll([.int(document)]) {
      (id: $0.int(0), rel: $0.int(1), passage: $0.intOrNil(2), anchor: $0.text(3))
    }
    for e in evs {
      report.evidenceChecked += 1
      let parsed = try? JSONValue.parse(e.anchor)
      let anchor = parsed.flatMap { $0.objectValue == nil ? nil : LooseAnchor($0) }
      let loc = try anchor.flatMap(locate)
      guard let loc, let passage = loc.passage else {
        report.evidenceOrphaned.append(.init(id: e.id, target: String(e.rel), quote: anchor?.quote,
          reason: loc != nil ? "no passage covers the words" : "the quoted words are not in the text"))
        continue
      }
      if e.passage == passage.id && !loc.moved {
        report.evidenceUnchanged += 1
        continue
      }
      // unmoved: the stored anchor (its offsets are where the words still are)
      let json = loc.anchor?.jsonText ?? e.anchor
      let up = try c.prepared(ProvenanceSQL.updateEvidenceAnchor)
      try up.bind(.int(passage.id), .int(Int64(loc.r.start)), .int(Int64(loc.r.end)), .text(json), .int(e.id))
      try up.run()
      report.evidenceReanchored.append(.init(id: e.id, from: e.passage.map(String.init) ?? "null", to: String(passage.id),
                                             passage: passage.id, method: loc.r.method, split: passage.split))
    }

    for (end, sql) in [("src", ProvenanceSQL.missingSrcPassages), ("dst", ProvenanceSQL.missingDstPassages)] {
      for r in try c.prepared(sql).all({ ($0.int(0), $0.text(1)) }) {
        report.missingEndpoints.append((r.0, end, Int64(JSNumber.parse(r.1))))
      }
    }
    return report
  }
}

extension Statement {
  /// Binds `values` and maps every row (the statement is reset afterwards).
  public func bindingFirstAll<T>(_ values: [SQLValue], _ map: (Row) throws -> T) throws -> [T] {
    try bind(values)
    return try all(map)
  }
}
