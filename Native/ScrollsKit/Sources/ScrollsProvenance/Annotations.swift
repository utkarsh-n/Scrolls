// OWNER: N6
// Port of server/provenance/annotations.mjs (SPEC §2.F, §3, D18): the interpretation notebook's storage.
//  · editing appends an annotation_revision (UPDATE/DELETE of revisions are refused by triggers);
//  · reinterpreting creates a NEW annotation with `supersedes`; the old one becomes 'superseded' and stays visible as a
//    layer ("Layer 'Reader A, 2026-10-03' — superseded 2026-11-12");
//  · withdrawing appends a last revision and sets status 'withdrawn'; nothing is ever deleted;
//  · as-of (a date, or a saved view's revision cutoff) shows what existed then, with the text it had then;
//  · machine annotations cannot be created, edited, withdrawn or reinterpreted here — only countered (honesty rule 10).
// Requests and responses are the reference's JSON bodies (`JSONValue`), so every check and message is the reference's;
// LiveAtlas decodes the bodies into the contract types. Writes take their clock from the journal entry (`at`), so a
// replayed generation carries the original times (D17, as-of reads).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// One write transaction of a journaled act: the connection, the id allocator, the text store and the act's time.
public struct WriteContext {
  public let c: Connection
  public let ids: RowIDAllocator
  public let text: any TextStore
  /// The journal entry's `at` (ISO 8601, ms): every row the act creates carries it.
  public let at: String
  /// Local-range ids for rows the user makes (IOS-SPEC §3.3).
  public let scope: IDScope

  public init(tx: WriteTx, text: any TextStore, at: String, scope: IDScope = .local) {
    c = tx.connection
    ids = tx.ids
    self.text = text
    self.at = at
    self.scope = scope
  }
}

public enum Annotations {
  /// Kinds a person writes (machine kinds come only from analysis runs and imports).
  public static let humanKinds = Vocab.annotationKinds.filter { !Vocab.machineAnnotationKinds.contains($0) }
  static let maxBody = 20000, maxTags = 32, maxTagLen = 64, maxRefs = 50
  static let refTypes = ["passage", "document", "occurrence", "relationship", "annotation", "expression", "cluster"]
  static let refRoles = ["supporting", "contradicting"]

  // MARK: validation

  /// `completeRequest`: a numeric target ref becomes a string; an anchor sent with offsets only gets doc_id (from a
  /// passage/occurrence target), field 'body', its quote and the text sha256.
  static func completeRequest(_ c: Connection, text: any TextStore, _ body: JSONObject) throws -> JSONObject {
    var out = body
    if case .object(var t)? = out["target"], case .number(let n)? = t["ref"] {
      t["ref"] = .string(JSNumber.format(n))
      out["target"] = .object(t)
    }
    guard case .object(let given)? = out["anchor"] else { return out }
    var a = given
    if a["field"] == nil { a["field"] = "body" }
    if a["doc_id"]?.integer == nil, case .object(let t)? = out["target"], let type = t["type"]?.stringValue,
      type == "passage" || type == "occurrence"
    {
      if let doc = try Refs.resolve(c, type: type, id: Refs.refString(t["ref"] ?? .null))?.docId { a["doc_id"] = .number(Double(doc)) }
    }
    if let doc = a["doc_id"]?.integer, a["quote"]?.stringValue == nil || a["sha256"]?.stringValue == nil {
      if let t = try Anchors.loadFieldText(c, text: text, doc: Int64(doc), field: a["field"]?.stringValue) {
        if a["sha256"]?.stringValue == nil { a["sha256"] = .string(t.sha) }
        if a["quote"]?.stringValue == nil, let s = a["start"]?.integer, let e = a["end"]?.integer {
          a["quote"] = .string(String(decoding: Anchors.jsSlice(t.units, s, e), as: UTF16.self))
        }
      }
    }
    out["anchor"] = .object(a)
    return out
  }

  /// `checkShape(shape, body)`: the first contract error decides the field; a missing anchor has its own sentence.
  static func checkShape(_ shape: Shape, named name: String, _ body: JSONValue) throws {
    let errs = shape.check(body)
    guard !errs.isEmpty else { return }
    if let missing = errs.first(where: { $0.contains("needs an anchor") }) {
      var m = missing
      if m.hasPrefix("$:") { m = String(m.dropFirst(2)).trimmingPrefixSpaces() }
      throw ProvenanceError.invalid(m, field: "anchor", hint: "Select the words the note is about.")
    }
    var first = errs[0]
    if first.hasPrefix("$.") { first = String(first.dropFirst(2)) } else if first.hasPrefix("$") { first = String(first.dropFirst()) }
    let field = String(first.unicodeScalars.prefix { ($0.value >= 0x61 && $0.value <= 0x7A) || $0 == "_" })
    throw ProvenanceError.invalid("The request does not match \(name): \(errs.prefix(3).joined(separator: "; "))",
                                  field: field.isEmpty ? nil : field,
                                  extra: [("errors", .array(errs.prefix(10).map(JSONValue.string)))])
  }

  static func checkBody(_ body: JSONValue?) throws -> String {
    guard let s = body?.stringValue, !JSString.trim(s).isEmpty else {
      throw ProvenanceError.invalid("The note is empty.", field: "body_md", hint: "Write what you read in the passage.")
    }
    if s.utf16.count > maxBody { throw ProvenanceError.invalid("The note is longer than \(maxBody) characters.", field: "body_md") }
    return s
  }

  static func checkTags(_ tags: JSONValue?) throws -> [String] {
    guard let tags, !tags.isNull else { return [] }
    guard let list = tags.arrayValue else { throw ProvenanceError.invalid("tags must be a list of strings.", field: "tags") }
    var out: [String] = []
    for t in list {
      guard let s = t.stringValue else { throw ProvenanceError.invalid("tags must be a list of strings.", field: "tags") }
      let v = JSString.trim(s)
      if v.isEmpty { continue }
      if v.utf16.count > maxTagLen { throw ProvenanceError.invalid("A tag may have at most \(maxTagLen) characters.", field: "tags") }
      if !JSString.includes(out, v) { out.append(v) }
    }
    if out.count > maxTags { throw ProvenanceError.invalid("At most \(maxTags) tags.", field: "tags") }
    return out
  }

  static func checkLayer(_ layer: JSONValue?) throws -> String? {
    guard let layer, !layer.isNull, layer.stringValue != "" else { return nil }
    guard let s = layer.stringValue, JSString.trim(s).utf16.count <= 80 else {
      throw ProvenanceError.invalid("layer must be a string of at most 80 characters.", field: "layer")
    }
    return JSString.trim(s)
  }

  static func checkStance(_ stance: JSONValue?) throws -> String? {
    guard let stance, !stance.isNull else { return nil }
    guard let s = stance.stringValue, JSString.includes(Vocab.stances, s) else {
      throw ProvenanceError.invalid("stance must be one of \(Vocab.stances.joined(separator: ", ")).", field: "stance")
    }
    return s
  }

  /// `DIM_KEY = /^[a-z][a-z0-9_]{0,39}$/`.
  static func isDimKey(_ k: String) -> Bool {
    let u = Array(k.utf16)
    guard let f = u.first, f >= 0x61 && f <= 0x7A, u.count <= 40 else { return false }
    return u.dropFirst().allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x5F }
  }

  /// `checkDimensions`: values are checked against `dimension_def`; an unknown key defines a custom dimension (type
  /// inferred: text, scale or bool) created by the author. Keys are visited in code-unit order (the reference visits
  /// insertion order; only the first error of a request with several bad keys can differ).
  static func checkDimensions(_ w: WriteContext, _ dims: JSONValue?, author: String) throws -> JSONObject {
    guard let dims, !dims.isNull else { return JSONObject() }
    guard let o = dims.objectValue else {
      throw ProvenanceError.invalid("dimensions must be an object of key → value.", field: "dimensions")
    }
    var out = JSONObject()
    for key in o.keys.sorted(by: CanonicalJSON.codeUnitLess) {
      let value = o[key]!
      if !isDimKey(key) {
        throw ProvenanceError.invalid("Dimension key '\(key)' must be lowercase letters, digits or _.", field: "dimensions")
      }
      if value.isNull { continue }
      var def = try w.c.prepared(ProvenanceSQL.dimensionDef).bindingFirst([.text(key)]) {
        (type: $0.text(1), options: $0.textOrNil(2))
      }
      if def == nil {
        let type: String
        switch value {
        case .bool: type = "bool"
        case .number: type = "scale"
        default: type = "text"
        }
        if type == "text" && value.stringValue == nil {
          throw ProvenanceError.invalid("Dimension '\(key)' needs a string, number or boolean.", field: "dimensions")
        }
        let ins = try w.c.prepared(ProvenanceSQL.insertCustomDimension)
        try ins.bind(.text(key), .text(key.replacingOccurrences(of: "_", with: " ")), .text(type), .text("human:\(author)"))
        try ins.run()
        def = (type, nil)
      }
      let opts = def!.options.flatMap { try? JSONValue.parse($0) }
      switch def!.type {
      case "enum":
        guard let list = opts?.arrayValue, list.contains(where: { sameValueZero($0, value) }) else {
          let shown = (opts?.arrayValue ?? []).map { $0.isNull ? "" : Anchors.jsString($0) }.joined(separator: ", ")
          throw ProvenanceError.invalid("Dimension '\(key)' must be one of \(shown).", field: "dimensions")
        }
      case "scale":
        let lo = opts?["min"].nonNull?.numberValue ?? -.infinity, hi = opts?["max"].nonNull?.numberValue ?? .infinity
        guard case .number(let n) = value, n.isFinite, n >= lo, n <= hi else {
          let range = lo.isFinite ? " from \(JSNumber.format(lo)) to \(JSNumber.format(hi))" : ""
          throw ProvenanceError.invalid("Dimension '\(key)' must be a number\(range).", field: "dimensions")
        }
      case "bool":
        guard value.boolValue != nil else { throw ProvenanceError.invalid("Dimension '\(key)' must be true or false.", field: "dimensions") }
      default:
        guard let s = value.stringValue, s.utf16.count <= 2000 else {
          throw ProvenanceError.invalid("Dimension '\(key)' must be text (≤ 2,000 characters).", field: "dimensions")
        }
      }
      out[key] = value
    }
    return out
  }

  static func sameValueZero(_ a: JSONValue, _ b: JSONValue) -> Bool {
    switch (a, b) {
    case (.number(let x), .number(let y)): x == y || (x.isNaN && y.isNaN)
    case (.string(let x), .string(let y)): JSString.equal(x, y)
    case (.bool(let x), .bool(let y)): x == y
    case (.null, .null): true
    default: false
    }
  }

  /// `checkEvidenceRefs`: each reference resolves; passage spans get a D18 anchor so they survive re-segmentation.
  static func checkEvidenceRefs(_ w: WriteContext, _ refs: JSONValue?) throws -> [JSONValue] {
    guard let refs, !refs.isNull else { return [] }
    guard let list = refs.arrayValue else { throw ProvenanceError.invalid("evidence_refs must be a list.", field: "evidence_refs") }
    if list.count > maxRefs { throw ProvenanceError.invalid("At most \(maxRefs) evidence references.", field: "evidence_refs") }
    return try list.map { r -> JSONValue in
      guard let o = r.objectValue, let type = o["type"]?.stringValue, refTypes.contains(type) else {
        throw ProvenanceError.invalid("Each evidence reference needs a type (\(refTypes.joined(separator: ", "))) and an id.",
                                      field: "evidence_refs")
      }
      let role = o["role"].nonNull ?? .string("supporting")
      guard let roleName = role.stringValue, refRoles.contains(roleName) else {
        throw ProvenanceError.invalid("An evidence reference's role is 'supporting' or 'contradicting'.", field: "evidence_refs")
      }
      let idText = o["id"].map(Refs.refString) ?? "undefined"
      guard let target = try Refs.resolve(w.c, type: type, id: idText) else {
        throw ProvenanceError.notFound("No \(type) \(idText).", field: "evidence_refs")
      }
      var out: JSONObject = ["type": .string(type), "id": .number(o["id"].map(jsNumber) ?? .nan), "role": .string(roleName)]
      if type == "passage", o["start"] != nil || o["end"] != nil, let p = target.passage {
        let shift = o["relative"] == .bool(true) ? p.startOff : 0
        let s = (o["start"].map(jsNumber) ?? .nan) + Double(shift), e = (o["end"].map(jsNumber) ?? .nan) + Double(shift)
        guard s.isFinite, e.isFinite, s == s.rounded(), e == e.rounded(), Int(s) >= p.startOff, Int(e) <= p.endOff, s < e else {
          throw ProvenanceError.invalid(
            "Span \(o["start"].map(Anchors.jsString) ?? "undefined")–\(o["end"].map(Anchors.jsString) ?? "undefined") is not inside passage \(p.id) (\(p.startOff)–\(p.endOff)).",
            field: "evidence_refs",
            hint: "Offsets index the document text (D4); send relative: true for offsets into the passage text.")
        }
        guard let t = try Anchors.loadFieldText(w.c, text: w.text, doc: p.documentId, field: p.field) else {
          throw ScrollsError(code: .internalError, message: "Internal error.", hint: "The passage's document has no text.", status: 500)
        }
        let start = Int(s), end = Int(e)
        let input: JSONValue = [
          "doc_id": .number(Double(p.documentId)), "field": .string(p.field), "start": .number(s), "end": .number(e),
          "quote": .string(String(decoding: Anchors.jsSlice(t.units, start, end), as: UTF16.self)),
        ]
        let (anchor, _) = try Anchors.check(w.c, text: w.text, input: input, docId: p.documentId, passage: p)
        out["start"] = .number(Double(anchor.start))
        out["end"] = .number(Double(anchor.end))
        out["quote"] = .string(anchor.quote)
        out["anchor"] = anchor.json
      }
      return .object(out)
    }
  }

  /// `Number(v)` of a JSON value.
  static func jsNumber(_ v: JSONValue) -> Double {
    switch v {
    case .number(let n): n
    case .string(let s): JSNumber.parse(s)
    case .bool(let b): b ? 1 : 0
    case .null: 0
    case .array(let a): a.isEmpty ? 0 : (a.count == 1 ? jsNumber(a[0]) : .nan)
    case .object: .nan
    }
  }

  struct CheckedTarget {
    let type: String
    let ref: String
    let synthetic: Int
    let anchor: AnchorValue?
    let relocated: String?
  }

  /// `checkTarget`: resolve and check the target of a new annotation.
  static func checkTarget(_ w: WriteContext, _ body: JSONObject, kind: String) throws -> CheckedTarget {
    let t = body["target"] ?? .null
    let type = t["type"]?.stringValue ?? ""
    let refText = Refs.refString(t["ref"] ?? .null)
    guard Vocab.annotationTargets.contains(type) else {
      throw ProvenanceError.invalid("Annotation target type '\(Anchors.jsString(t["type"] ?? .null))' is not supported.", field: "target")
    }
    if kind == "label" && type != "cluster" {
      throw ProvenanceError.invalid("A 'label' renames a machine context group; its target must be a cluster.", field: "kind",
                                    hint: "Use kind interpretation for other notes.")
    }
    guard let target = try Refs.resolve(w.c, type: type, id: refText) else {
      throw ProvenanceError.notFound("No \(type) \(refText).", field: "target")
    }
    var anchor: AnchorValue?, relocated: String?
    let sentAnchor = body["anchor"].map { !$0.isFalsy } ?? false
    if type == "passage" || type == "occurrence" {
      (anchor, relocated) = try Anchors.check(w.c, text: w.text, input: body["anchor"], docId: target.docId, passage: target.passage)
    } else if type == "document" && sentAnchor {
      (anchor, relocated) = try Anchors.check(w.c, text: w.text, input: body["anchor"], docId: target.docId, passage: nil)
    } else if sentAnchor {
      throw ProvenanceError.invalid("A \(type) target takes no anchor.", field: "anchor")
    }
    return CheckedTarget(type: type, ref: target.ref, synthetic: target.synthetic != 0 ? 1 : 0, anchor: anchor, relocated: relocated)
  }

  static func indexRevision(_ w: WriteContext, revId: Int64, body: String, tags: [String]) throws {
    let s = try w.c.prepared(ProvenanceSQL.insertAnnotationFTS)
    try s.bind(.int(revId), .text(Tokenizer.tokens(body).tokens.joined(separator: " ")),
               .text(Tokenizer.tokens(tags.joined(separator: " ")).tokens.joined(separator: " ")))
    try s.run()
  }

  struct RevisionInput {
    var body: String
    var stance: String?
    var dimensions: JSONValue
    var tags: [String]
    var refs: JSONValue
    var reason: String?
    var author: String
  }

  @discardableResult
  static func insertRevision(_ w: WriteContext, annotation: Int64, rev: Int, _ r: RevisionInput) throws -> Int64 {
    let revId = try w.ids.nextLog("annotation_revision")
    let s = try w.c.prepared(ProvenanceSQL.insertAnnotationRevision)
    try s.bind(.int(revId), .int(annotation), .int(Int64(rev)), .text(r.body), .string(r.stance),
               .text(CanonicalJSON.string(r.dimensions)), .text(CanonicalJSON.string(.array(r.tags.map(JSONValue.string)))),
               .text(CanonicalJSON.string(r.refs)), .string(r.reason), .text(r.author), .text(w.at))
    try s.run()
    try indexRevision(w, revId: revId, body: r.body, tags: r.tags)
    return revId
  }

  // MARK: rows

  struct Row {
    let id: Int64
    let targetType: String
    let targetRef: String
    let anchorJSON: String?
    let kind: String
    let author: String
    let isMachine: Int
    let method: String?
    let runId: Int64?
    let layer: String?
    let supersedes: Int64?
    let status: String
    let isSynthetic: Int
    let currentRev: Int
    let createdAt: String
  }

  static func readRow(_ r: ScrollsStore.Row) -> Row {
    Row(id: r.int(0), targetType: r.text(1), targetRef: r.text(2), anchorJSON: r.textOrNil(3), kind: r.text(4), author: r.text(5),
        isMachine: Int(r.int(6)), method: r.textOrNil(7), runId: r.intOrNil(8), layer: r.textOrNil(9), supersedes: r.intOrNil(10),
        status: r.text(11), isSynthetic: Int(r.int(12)), currentRev: Int(r.int(13)), createdAt: r.text(14))
  }

  /// `annotationRow(db, id)`, or 404.
  static func row(_ c: Connection, _ id: String) throws -> Row {
    let n = JSNumber.parse(id)
    if JSNumber.isSafeInteger(n), n > 0,
      let a = try c.prepared(ProvenanceSQL.annotationById).bindingFirst([.int(Int64(n))], readRow)
    {
      return a
    }
    throw ProvenanceError.notFound("No annotation \(id).")
  }

  static func refuseMachine(_ a: Row) throws {
    if a.isMachine == 1 || Vocab.machineAnnotationKinds.contains(a.kind) {
      throw ProvenanceError.conflict("E_MACHINE_ANNOTATION", "Machine annotations cannot be edited, only countered.",
                                     hint: "Add your own annotation of kind evidence_against.", detail: ["kind": .string(a.kind)])
    }
  }

  static func supersededBy(_ c: Connection, _ id: Int64) throws -> (id: Int64, createdAt: String)? {
    try c.prepared(ProvenanceSQL.supersededBy).bindingFirst([.int(id)]) { ($0.int(0), $0.text(1)) }
  }

  static func refuseInactive(_ c: Connection, _ a: Row, verb: String) throws {
    if a.status == "superseded" {
      let by = try supersededBy(c, a.id)
      throw ProvenanceError.conflict(
        "E_ANNOTATION_SUPERSEDED", "Annotation \(a.id) was already reinterpreted as \(by.map { String($0.id) } ?? "a newer one").",
        hint: by.map { "\(verb) \($0.id) instead." }, detail: ["by": by.map { .number(Double($0.id)) } ?? .null])
    }
    if a.status == "withdrawn" {
      throw ProvenanceError.conflict("E_ANNOTATION_WITHDRAWN", "Annotation \(a.id) was withdrawn.",
                                     hint: "Write a new annotation; the withdrawn one stays in the history.",
                                     detail: ["id": .number(Double(a.id))])
    }
  }

  struct RevisionRow {
    let id: Int64
    let rev: Int
    let body: String
    let stance: String?
    let dimensions: String
    let tags: String
    let refs: String
    let reason: String?
    let author: String
    let at: String
  }

  static func readRevision(_ r: ScrollsStore.Row) -> RevisionRow {
    RevisionRow(id: r.int(0), rev: Int(r.int(1)), body: r.text(2), stance: r.textOrNil(3), dimensions: r.text(4), tags: r.text(5),
                refs: r.text(6), reason: r.textOrNil(7), author: r.text(8), at: r.text(9))
  }

  static func revisions(_ c: Connection, _ annotation: Int64) throws -> [RevisionRow] {
    try c.prepared(ProvenanceSQL.revisionsOf).bindingFirstAll([.int(annotation)], readRevision)
  }

  static func parsed(_ s: String, _ fallback: JSONValue) -> JSONValue { (try? JSONValue.parse(s)) ?? fallback }

  // MARK: writes

  /// POST /api/annotations: passage and occurrence targets need an anchor (D18); the server recomputes its
  /// prefix/suffix and re-locates stale offsets by the quote. → `{id, rev: 1, anchor?, relocated?}`
  public static func create(_ w: WriteContext, _ request: JSONValue) throws -> JSONValue {
    guard let req = request.objectValue else { throw ProvenanceError.invalid("Send a JSON object.", field: nil) }
    let body = try completeRequest(w.c, text: w.text, req)
    try checkShape(.annotationRequest, named: "AnnotationRequest", .object(body))
    let kind = body["kind"]?.stringValue ?? ""
    if Vocab.machineAnnotationKinds.contains(kind) {
      throw ProvenanceError.invalid("Kind '\(kind)' is written by analysis runs, not by hand.", field: "kind",
                                    hint: "Counter a machine annotation with your own note (evidence_against).")
    }
    let author = try Refs.authorName(body["author"])
    return try insert(w, body, author: author, supersedes: nil)
  }

  static func insert(_ w: WriteContext, _ body: JSONObject, author: String, supersedes: Int64?) throws -> JSONValue {
    let kind = body["kind"]?.stringValue ?? ""
    let text = try checkBody(body["body_md"])
    let target = try checkTarget(w, body, kind: kind)
    let tags = try checkTags(body["tags"])
    let dimensions = try checkDimensions(w, body["dimensions"], author: author)
    let refs = try checkEvidenceRefs(w, body["evidence_refs"])
    let stance = try checkStance(body["stance"])
    let layer = try checkLayer(body["layer"])
    let id = try w.ids.next("annotation", w.scope)
    let s = try w.c.prepared(ProvenanceSQL.insertAnnotation)
    try s.bind(.int(id), .text(target.type), .text(target.ref), .string(target.anchor?.jsonText), .text(kind), .text(author),
               .string(layer), .integer(supersedes), .int(Int64(target.synthetic)), .text(w.at))
    try s.run()
    try insertRevision(w, annotation: id, rev: 1, RevisionInput(body: text, stance: stance, dimensions: .object(dimensions),
                                                               tags: tags, refs: .array(refs), reason: nil, author: author))
    var out: JSONObject = ["id": .number(Double(id)), "rev": 1]
    if let a = target.anchor { out["anchor"] = a.json }
    if let r = target.relocated { out["relocated"] = .string(r) }
    return .object(out)
  }

  /// PATCH /api/annotations/:id: append a revision. Omitted dimensions, tags, stance and evidence_refs carry over from
  /// the previous revision. → `{id, rev}`
  public static func revise(_ w: WriteContext, id: String, _ request: JSONValue) throws -> JSONValue {
    guard let body = request.objectValue else { throw ProvenanceError.invalid("Send a JSON object.", field: nil) }
    try checkShape(.annotationPatch, named: "AnnotationPatch", request)
    let a = try row(w.c, id)
    try refuseMachine(a)
    try refuseInactive(w.c, a, verb: "Edit")
    let author = body["author"] == nil ? a.author : try Refs.authorName(body["author"])
    guard let prev = try revisions(w.c, a.id).last else { throw ProvenanceError.notFound("No annotation \(id).") }
    let rev = a.currentRev + 1
    let text = try checkBody(body["body_md"])
    let stance = body["stance"] == nil ? prev.stance : try checkStance(body["stance"])
    let dims: JSONValue = body["dimensions"] == nil ? parsed(prev.dimensions, [:])
      : .object(try checkDimensions(w, body["dimensions"], author: author))
    let tags = body["tags"] == nil ? (parsed(prev.tags, []).arrayValue ?? []).compactMap(\.stringValue) : try checkTags(body["tags"])
    let refs: JSONValue = body["evidence_refs"] == nil ? parsed(prev.refs, []) : .array(try checkEvidenceRefs(w, body["evidence_refs"]))
    var reason: String?
    if let r = body["reason"]?.stringValue, !JSString.trim(r).isEmpty {
      reason = String(decoding: Anchors.jsSlice(Array(JSString.trim(r).utf16), 0, 2000), as: UTF16.self)
    }
    try insertRevision(w, annotation: a.id, rev: rev, RevisionInput(body: text, stance: stance, dimensions: dims, tags: tags,
                                                                   refs: refs, reason: reason, author: author))
    let up = try w.c.prepared(ProvenanceSQL.setAnnotationRev)
    try up.bind(.int(Int64(rev)), .int(a.id))
    try up.run()
    return ["id": .number(Double(a.id)), "rev": .number(Double(rev))]
  }

  /// POST /api/annotations/:id/reinterpret: a new annotation on the same target that supersedes this one; the old one
  /// stays as a visible layer. The new layer defaults to "<author>, <date>". → `{id, supersedes, rev: 1}`
  public static func reinterpret(_ w: WriteContext, id: String, _ request: JSONValue) throws -> JSONValue {
    guard let body = request.objectValue else { throw ProvenanceError.invalid("Send a JSON object.", field: nil) }
    let old = try row(w.c, id)
    try refuseMachine(old)
    try refuseInactive(w.c, old, verb: "Reinterpret")
    let target = body["target"].nonNull ?? .object(["type": .string(old.targetType), "ref": .string(old.targetRef)])
    if target["type"]?.stringValue != old.targetType || Refs.refString(target["ref"] ?? .null) != old.targetRef {
      throw ProvenanceError.invalid("A reinterpretation keeps the target \(old.targetType):\(old.targetRef).", field: "target",
                                    hint: "Write a new annotation for another target.")
    }
    let author = try Refs.authorName(body["author"].nonNull ?? .string(old.author))
    var next = body
    next["target"] = .object(["type": .string(old.targetType), "ref": .string(old.targetRef)])
    next["kind"] = body["kind"].nonNull ?? .string(old.kind)
    if let a = body["anchor"].nonNull {
      next["anchor"] = a
    } else if let stored = old.anchorJSON.flatMap({ try? JSONValue.parse($0) }), !stored.isNull {
      next["anchor"] = stored
    } else {
      next["anchor"] = nil
    }
    next["layer"] = body["layer"].nonNull ?? .string("\(author), \(String(w.at.prefix(10)))")
    try checkShape(.annotationRequest, named: "AnnotationRequest", .object(try completeRequest(w.c, text: w.text, next)))
    let kind = next["kind"]?.stringValue ?? ""
    if Vocab.machineAnnotationKinds.contains(kind) {
      throw ProvenanceError.invalid("Kind '\(kind)' is written by analysis runs, not by hand.", field: "kind")
    }
    let created = try insert(w, try completeRequest(w.c, text: w.text, next), author: author, supersedes: old.id)
    let up = try w.c.prepared(ProvenanceSQL.supersedeAnnotation)
    try up.bind(.int(old.id))
    try up.run()
    return ["id": created["id"] ?? .null, "supersedes": .number(Double(old.id)), "rev": 1]
  }

  /// POST /api/annotations/:id/withdraw: append a last revision (same text) and set status 'withdrawn'.
  /// → `{id, rev, status: 'withdrawn'}`
  public static func withdraw(_ w: WriteContext, id: String, _ request: JSONValue) throws -> JSONValue {
    let body = request.objectValue ?? JSONObject()
    let a = try row(w.c, id)
    try refuseMachine(a)
    try refuseInactive(w.c, a, verb: "Withdraw")
    let author = body["author"] == nil ? a.author : try Refs.authorName(body["author"])
    guard let prev = try revisions(w.c, a.id).last else { throw ProvenanceError.notFound("No annotation \(id).") }
    let rev = a.currentRev + 1
    var reason = "withdrawn"
    if let r = body["reason"]?.stringValue, !JSString.trim(r).isEmpty {
      reason = "withdrawn: " + String(decoding: Anchors.jsSlice(Array(JSString.trim(r).utf16), 0, 2000), as: UTF16.self)
    }
    try insertRevision(w, annotation: a.id, rev: rev, RevisionInput(
      body: prev.body, stance: prev.stance, dimensions: parsed(prev.dimensions, [:]),
      tags: (parsed(prev.tags, []).arrayValue ?? []).compactMap(\.stringValue), refs: parsed(prev.refs, []), reason: reason,
      author: author))
    let up = try w.c.prepared(ProvenanceSQL.withdrawAnnotation)
    try up.bind(.int(Int64(rev)), .int(a.id))
    try up.run()
    return ["id": .number(Double(a.id)), "rev": .number(Double(rev)), "status": "withdrawn"]
  }

  // MARK: reads

  static func revisionJSON(_ r: RevisionRow) -> JSONValue {
    [
      "rev": .number(Double(r.rev)), "body_md": .string(r.body), "stance": r.stance.map(JSONValue.string) ?? .null,
      "dimensions": parsed(r.dimensions, [:]), "tags": parsed(r.tags, []), "evidence_refs": parsed(r.refs, []),
      "author": .string(r.author), "at": .string(r.at), "reason": r.reason.map(JSONValue.string) ?? .null,
    ]
  }

  /// GET /api/annotations/:id/revisions: every revision, oldest first.
  public static func revisionsJSON(_ c: Connection, id: String) throws -> JSONValue {
    let a = try row(c, id)
    return .array(try revisions(c, a.id).map(revisionJSON))
  }

  /// `parseAsOf`: 'YYYY-MM-DD' (end of that day, UTC) or an ISO date-time → an ISO bound for string comparison.
  public static func parseAsOf(_ s: String?) throws -> String? {
    guard let s, !s.isEmpty else { return nil }
    if let bound = IsoTime.dateOnlyEndOfDay(s) { return bound }
    if let iso = IsoTime.normalizedDateTime(s) { return iso }
    throw ProvenanceError.invalid("as_of '\(s)' is not a date (YYYY-MM-DD) or an ISO date-time.", field: "as_of")
  }

  static func splitList(_ v: String?) -> [String]? {
    guard let v, !v.isEmpty else { return nil }
    return JSString.split(v, ",").map { JSString.trim($0) }.filter { !$0.isEmpty }
  }

  static func hypothesisLabel(_ a: Row) -> String { "Hypothesis — by \(a.author), \(a.createdAt.prefix(10)) — not evidence" }

  /// A bound of `stateAt`: a time, or a saved view's annotation revision cutoff.
  enum Bound {
    case time(String)
    case revCutoff(Int64)
  }

  struct State {
    let shown: RevisionRow
    let status: String
    let withdrawnAt: String?
    let supersededAt: String?
    let count: Int
  }

  /// The state of an annotation at a bound (none = now): which revision was visible, and its status then. nil for an
  /// annotation that did not exist yet.
  static func stateAt(_ a: Row, _ revs: [RevisionRow], _ successor: (id: Int64, createdAt: String, firstId: Int64, firstAt: String)?,
                      _ bound: Bound?) -> State? {
    func visible(id: Int64, at: String) -> Bool {
      switch bound {
      case nil: true
      case .time(let t)?: CanonicalJSON.codeUnitLess(at, t) || at == t
      case .revCutoff(let cut)?: id <= cut
      }
    }
    let shownRevs = revs.filter { visible(id: $0.id, at: $0.at) }
    guard let shown = shownRevs.last, let last = revs.last else { return nil }
    var status = "active"
    var withdrawnAt: String?, supersededAt: String?
    if a.status == "withdrawn" && visible(id: last.id, at: last.at) {
      status = "withdrawn"
      withdrawnAt = last.at
    }
    if let s = successor, visible(id: s.firstId, at: s.firstAt) {
      status = "superseded"
      supersededAt = s.createdAt
    }
    return State(shown: shown, status: status, withdrawnAt: withdrawnAt, supersededAt: supersededAt, count: shownRevs.count)
  }

  /// `annotationShownAt(db, a, revCutoff)`: the revision an annotation showed at a saved view's annotation revision
  /// cutoff, and its status then (RF-2: Compare's human counts as saved), or nil when it did not exist yet.
  public static func shownAt(_ c: Connection, annotation id: Int64, revCutoff: Int64) throws -> (revision: JSONValue, status: String)? {
    guard let a = try c.prepared(ProvenanceSQL.annotationById).bindingFirst([.int(id)], readRow) else { return nil }
    let st = try stateAt(a, revisions(c, a.id), successor(c, a.id), .revCutoff(revCutoff))
    return st.map { (revisionJSON($0.shown), $0.status) }
  }

  static func successor(_ c: Connection, _ id: Int64) throws -> (id: Int64, createdAt: String, firstId: Int64, firstAt: String)? {
    guard let s = try supersededBy(c, id) else { return nil }
    guard let first = try c.prepared(ProvenanceSQL.firstRevision).bindingFirst([.int(s.id)], { ($0.int(0), $0.text(1)) }) else {
      return nil
    }
    return (s.id, s.createdAt, first.0, first.1)
  }

  struct Facets {
    var tag: String?
    var dimension: (key: String, value: String?)?
    var contradicted: Bool
  }

  static func isContradicted(_ c: Connection, _ a: Row, _ refs: JSONValue) throws -> Bool {
    if (refs.arrayValue ?? []).contains(where: { $0["role"]?.stringValue == "contradicting" }) { return true }
    return try c.prepared(ProvenanceSQL.counterAnnotation).bindingFirst([.text(String(a.id))]) { _ in true } ?? false
  }

  static func itemJSON(_ c: Connection, _ a: Row, _ bound: Bound?, include: Set<String>, facets: Facets) throws -> JSONValue? {
    let revs = try revisions(c, a.id)
    let succ = try successor(c, a.id)
    guard let st = stateAt(a, revs, succ, bound) else { return nil }
    if st.status == "superseded" && !include.contains("superseded") { return nil }
    if st.status == "withdrawn" && !include.contains("withdrawn") { return nil }
    let r = revisionJSON(st.shown)
    let tags = r["tags"] ?? []
    if let tag = facets.tag, !(tags.arrayValue ?? []).contains(where: { $0.stringValue.map { JSString.equal($0, tag) } ?? false }) {
      return nil
    }
    if let d = facets.dimension {
      guard let v = r["dimensions"]?[d.key] else { return nil }
      if let want = d.value, Anchors.jsString(v) != want { return nil }
    }
    let contradicted = try isContradicted(c, a, r["evidence_refs"] ?? [])
    if facets.contradicted && !contradicted { return nil }
    var item: JSONObject = [
      "id": .number(Double(a.id)), "target": ["type": .string(a.targetType), "ref": .string(a.targetRef)],
      "kind": .string(a.kind), "author": .string(a.author), "is_machine": .bool(a.isMachine == 1),
      "method": a.method.map(JSONValue.string) ?? .null, "run_id": a.runId.map { .number(Double($0)) } ?? .null,
      "status": .string(st.status), "rev": r["rev"] ?? .null, "revisions": .number(Double(st.count)),
      "body_md": r["body_md"] ?? .null, "stance": r["stance"] ?? .null, "dimensions": r["dimensions"] ?? [:], "tags": tags,
      "evidence_refs": r["evidence_refs"] ?? [], "rev_at": r["at"] ?? .null, "reason": r["reason"] ?? .null,
      "layer": a.layer.map(JSONValue.string) ?? .null, "supersedes": a.supersedes.map { .number(Double($0)) } ?? .null,
      "superseded_by": st.status == "superseded" ? succ.map { .number(Double($0.id)) } ?? .null : .null,
      "superseded_at": st.supersededAt.map(JSONValue.string) ?? .null,
      "withdrawn_at": st.withdrawnAt.map(JSONValue.string) ?? .null,
      "anchor": a.anchorJSON.flatMap { try? JSONValue.parse($0) } ?? .null,
      "contradicted": .bool(contradicted), "created_at": .string(a.createdAt), "synthetic": .bool(a.isSynthetic == 1),
    ]
    if a.kind == "hypothesis" { item["label"] = .string(hypothesisLabel(a)) }
    if a.isMachine == 1 { item["fallible"] = true }
    return .object(item)
  }

  /// GET /api/annotations: active annotations by default (machine ones carry fallible: true); `include` adds the
  /// superseded and withdrawn layers; `as_of` / `rev_cutoff` show what existed then, with the text of then.
  public static func list(_ c: Connection, _ q: AnnotationsRequest) throws -> JSONValue {
    let limit = try ProvenancePaging.limitFor(q.limit, max: 200, default: 50)
    let after = Int64(try ProvenancePaging.cursor(q.cursor)?["after"]?.integer ?? 0)
    var include = Set(splitList(q.include) ?? [])
    if include.contains("all") { include.formUnion(["superseded", "withdrawn"]) }
    let asOf = try parseAsOf(q.asOf)
    var revCutoff: Int64?
    if let r = q.revCutoff {
      guard r >= 0 else { throw ProvenanceError.invalid("rev_cutoff must be a non-negative integer.", field: "rev_cutoff") }
      revCutoff = Int64(r)
    }
    let bound: Bound? = asOf.map(Bound.time) ?? revCutoff.map(Bound.revCutoff)
    var facets = Facets(tag: q.tag.flatMap { $0.isEmpty ? nil : $0 }, dimension: nil, contradicted: q.contradicted == true)
    if let d = q.dimension, !d.isEmpty {
      let parts = JSString.split(d, ":")
      guard isDimKey(parts[0]) else {
        throw ProvenanceError.invalid("dimension '\(d)' must look like key or key:value.", field: "dimension")
      }
      facets.dimension = (parts[0], parts.count > 1 ? parts.dropFirst().joined(separator: ":") : nil)
    }
    let from = try parseAsOf(q.from), to = try parseAsOf(q.to)

    var targetType: String?, targetRef: String?
    if let t = q.target, !t.isEmpty {
      let i = JSString.indexOf(t, ":")
      guard i > 0 else { throw ProvenanceError.invalid("target '\(t)' must look like passage:901.", field: "target") }
      let u = Array(t.utf16)
      let type = String(decoding: u[..<i], as: UTF16.self)
      guard Vocab.annotationTargets.contains(type) else {
        throw ProvenanceError.invalid("Annotation target type '\(type)' is not supported.", field: "target")
      }
      targetType = type
      targetRef = String(decoding: u[(i + 1)...], as: UTF16.self)
    }
    let doc: Int64? = q.doc.map { $0.rawValue }
    var kinds: String?
    if let ks = splitList(q.kind) {
      for k in ks where !Vocab.annotationKinds.contains(k) { throw ProvenanceError.invalid("Unknown kind '\(k)'.", field: "kind") }
      kinds = CanonicalJSON.string(.array(ks.map(JSONValue.string)))
    }
    let machine: Int64? = q.machine == "0" ? 0 : q.machine == "only" ? 1 : nil
    var match: String?
    if let text = q.q, !text.isEmpty {
      let terms = Tokenizer.tokens(text).tokens
      if terms.isEmpty { return ["items": [], "cursor": .null] }
      match = terms.map { "\"" + $0.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }.joined(separator: " ")
    }
    func page(_ lastId: Int64, _ n: Int) throws -> [Row] {
      try c.prepared(ProvenanceSQL.listAnnotations).bindingFirstAll([
        .int(lastId), .string(targetType), .string(targetRef), .integer(doc), .string(doc.map(String.init)), .string(kinds),
        .string(q.author.flatMap { $0.isEmpty ? nil : $0 }), .string(q.layer.flatMap { $0.isEmpty ? nil : $0 }), .integer(machine),
        .string(match), .string(asOf), .string(from.map { String($0.prefix(10)) }), .string(to), .int(Int64(n)),
      ], readRow)
    }
    var items: [JSONValue] = []
    var lastId = after
    var exhausted = false
    let batch = max(limit * 2, 50)
    while items.count < limit && !exhausted {
      let rows = try page(lastId, batch)
      if rows.count < batch { exhausted = true }
      for a in rows {
        lastId = a.id
        if let item = try itemJSON(c, a, bound, include: include, facets: facets) { items.append(item) }
        if items.count >= limit { break }
      }
    }
    var more = false
    if items.count >= limit { more = try !exhausted || !page(lastId, 1).isEmpty }
    return ["items": .array(items), "cursor": more ? .string(ProvenancePaging.encodeCursor(["after": .number(Double(lastId))])) : .null]
  }
}

/// The reference's ISO handling of `as_of` (Date.parse + toISOString for the accepted grammars).
enum IsoTime {
  /// 'YYYY-MM-DD' → 'YYYY-MM-DDT23:59:59.999Z' when V8 accepts the date.
  static func dateOnlyEndOfDay(_ s: String) -> String? {
    let u = Array(s.utf8)
    guard u.count == 10, u[4] == 0x2D, u[7] == 0x2D, digits(u, 0, 4) != nil, let m = digits(u, 5, 2), let d = digits(u, 8, 2),
      (1...12).contains(m), (1...31).contains(d)
    else { return nil }
    return "\(s)T23:59:59.999Z"
  }

  /// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$` and a valid instant → `new Date(s).toISOString()`.
  static func normalizedDateTime(_ s: String) -> String? {
    let u = Array(s.utf8)
    guard u.count >= 17, u.last == 0x5A, u[4] == 0x2D, u[7] == 0x2D, u[10] == 0x54, u[13] == 0x3A,
      let y = digits(u, 0, 4), let mo = digits(u, 5, 2), let d = digits(u, 8, 2), let h = digits(u, 11, 2), let mi = digits(u, 14, 2)
    else { return nil }
    var sec = 0, ms = 0
    var i = 16
    if i < u.count - 1 {
      guard u[i] == 0x3A, let ss = digits(u, i + 1, 2) else { return nil }
      sec = ss
      i += 3
      if i < u.count - 1 {
        guard u[i] == 0x2E else { return nil }
        let frac = u[(i + 1)..<(u.count - 1)]
        guard (1...3).contains(frac.count), frac.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return nil }
        let f = String(decoding: frac, as: UTF8.self)
        ms = Int(f.padding(toLength: 3, withPad: "0", startingAt: 0))!
        i = u.count - 1
      }
    }
    guard i == u.count - 1 else { return nil }
    guard (1...12).contains(mo), (1...31).contains(d), h <= 24, mi <= 59, sec <= 59 else { return nil }
    if h == 24 && (mi != 0 || sec != 0 || ms != 0) { return nil }
    // V8 accepts day 29–31 of any month and rolls over; 24:00:00.000 is the next day's midnight
    var day = DayMath.dayFromYMD(y, mo, 1) + d - 1
    var hh = h
    if h == 24 {
      day += 1
      hh = 0
    }
    let ymd = DayMath.ymdFromDay(day)
    func p(_ v: Int, _ n: Int) -> String { String(format: "%0\(n)d", v) }
    return "\(p(ymd.y, 4))-\(p(ymd.m, 2))-\(p(ymd.d, 2))T\(p(hh, 2)):\(p(mi, 2)):\(p(sec, 2)).\(p(ms, 3))Z"
  }

  static func digits(_ u: [UInt8], _ at: Int, _ n: Int) -> Int? {
    guard at + n <= u.count else { return nil }
    var v = 0
    for k in at..<(at + n) {
      guard u[k] >= 0x30 && u[k] <= 0x39 else { return nil }
      v = v * 10 + Int(u[k] - 0x30)
    }
    return v
  }

}

extension ProvenancePaging {
  /// `limitParam(query, {max, dflt})` with the reference's message.
  public static func limitFor(_ value: Int?, max: Int, default d: Int) throws -> Int {
    guard let value else { return Swift.min(d, max) }
    guard value >= 1 else {
      throw ScrollsError.badRequest(.badLimit, "limit must be a positive integer (got '\(value)').", hint: "Use 1–\(max).")
    }
    return Swift.min(value, max)
  }

  /// `decodeCursor(cursor)`.
  public static func cursor(_ s: String?) throws -> JSONObject? {
    guard let s, !s.isEmpty else { return nil }
    var b64 = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    if let data = Data(base64Encoded: b64), case .object(let o)? = try? JSONValue.parse(data) { return o }
    throw ScrollsError.badRequest(.badCursor, "The cursor is not one this server issued.", hint: "Restart the list without a cursor.")
  }

  /// `encodeCursor(obj)`: base64url of the object's JSON.
  public static func encodeCursor(_ o: JSONObject) -> String {
    Data(CanonicalJSON.string(.object(o)).utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}

/// The list helpers of `router.mjs` (ScrollsService has its own `Paging` for the other routes).
public enum ProvenancePaging {}
