// OWNER: N6
// Port of server/provenance/relationships.mjs, reviews.mjs and lineage/hypotheses.mjs (SPEC §2.C, §7.1, D7, I3):
// edge cards, human-proposed edges, attached evidence, reviews and competing hypothesis groups.
// What a person creates here is ALWAYS evidence_status 'proposed', origin 'human' (the §3 CHECKs enforce it a second
// time); evidence_status and the endpoints are never updated (rel_evidence_immutable trigger). Every change appends a
// relationship_revision; nothing is deleted. Evidence spans carry D18 anchors. A review writes an annotation
// (confirm → evidence_for; reject → evidence_against; dispute → evidence_against with stance 'alternative') and a
// revision, then recomputes review_status from each reviewer's latest decision. Confirming one hypothesis of a group
// leaves the others exactly as they were (never auto-rejected).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

public enum Relationships {
  /// The fixed sentence every edge card carries (§2.C).
  public static let caution = "Shared wording or similar contexts can come from a common source; they do not establish influence or intent."

  /// Evidence status in words (§2.C edge card).
  public static let statusWords: [String: String] = [
    "documented": "documented — an external record states this link",
    "documented_unrecorded": "documented upstream; source not recorded by Cipher (DOC*)",
    "computed": "computed — an algorithmic estimate, not a record",
    "proposed": "proposed — a hypothesis, not evidence",
  ]

  /// Roles a person may attach (a citation cue is found by the cue detector, not asserted by hand).
  public static let humanEvidenceRoles = ["supporting", "contradicting", "source_span", "target_span", "external_record"]
  static let endpointTypes = ["document", "passage", "occurrence", "expression", "etymon", "cluster"]

  // MARK: evidence spans

  /// A checked evidence span (`checkEvidenceSpan`).
  struct Span {
    var passageId: Int64?
    var start: Int?
    var end: Int?
    var role: String
    var anchor: AnchorValue?
    var detail: JSONValue?
    var synthetic: Int
  }

  /// `checkEvidenceSpan(db, ev, {roles, field})`: validate one evidence span and anchor it. Spans index the document
  /// text (D4); `relative: true` means start/end index the passage text instead.
  static func checkSpan(_ w: WriteContext, _ ev: JSONValue?, roles: [String] = humanEvidenceRoles, field: String = "evidence") throws -> Span {
    guard let ev, let o = ev.objectValue else { throw ProvenanceError.invalid("Each evidence item must be an object.", field: field) }
    let roleValue = o["role"].nonNull ?? .string("supporting")
    let role = roleValue.stringValue ?? Anchors.jsString(roleValue)
    guard roleValue.stringValue != nil, Vocab.evidenceRoles.contains(role) else {
      throw ProvenanceError.invalid("Evidence role '\(role)' is not one of \(Vocab.evidenceRoles.joined(separator: ", ")).", field: "role")
    }
    guard roles.contains(role) else {
      throw ProvenanceError.invalid("Evidence role '\(role)' cannot be attached by hand.", field: "role",
                                    hint: "Attribution cues are found by the cue detector; attach the span as supporting.")
    }
    if role == "external_record" {
      let locator = o["locator"]?.stringValue.map(JSString.trim) ?? ""
      if locator.isEmpty {
        throw ProvenanceError.invalid("An external record needs a locator (a URL or catalogue reference).", field: "locator")
      }
      var detail: JSONObject = ["locator": .string(locator)]
      if let q = o["quote"]?.stringValue, !q.isEmpty { detail["quote"] = .string(q) }
      return Span(passageId: nil, start: nil, end: nil, role: role, anchor: nil, detail: .object(detail), synthetic: 0)
    }
    let pidNumber = Annotations.jsNumber(o["passage"] ?? .string("undefined"))
    guard JSNumber.isSafeInteger(pidNumber), pidNumber > 0 else {
      throw ProvenanceError.invalid("Each evidence span needs a passage id.", field: "passage")
    }
    let pid = Int64(pidNumber)
    guard let target = try Refs.resolve(w.c, type: "passage", id: String(pid)), let p = target.passage else {
      throw ProvenanceError.notFound("No passage \(pid).", field: "passage")
    }
    guard let s0 = o["start"]?.integer, let e0 = o["end"]?.integer else {
      throw ProvenanceError.invalid("Each evidence span needs integer start and end.", field: "start")
    }
    let shift = o["relative"] == .bool(true) ? p.startOff : 0
    let start = s0 + shift, end = e0 + shift
    if start < p.startOff || end > p.endOff || start >= end {
      throw ProvenanceError.invalid("Span \(start)–\(end) is not inside passage \(pid) (\(p.startOff)–\(p.endOff)).", field: "start",
                                    hint: "Offsets index the document text (D4); send relative: true for offsets into the passage text.")
    }
    let t = try Anchors.loadFieldText(w.c, text: w.text, doc: p.documentId, field: p.field)
    let quote: JSONValue = t.map { .string(String(decoding: Anchors.jsSlice($0.units, start, end), as: UTF16.self)) } ?? .null
    if let q = o["quote"]?.stringValue, !q.isEmpty, !(quote.stringValue.map { JSString.equal($0, q) } ?? false) {
      throw ProvenanceError.invalid("The quoted words do not match the text at these offsets.", field: "quote",
                                    hint: "Offsets are UTF-16 code units into the document text (D4).")
    }
    let input: JSONValue = ["doc_id": .number(Double(p.documentId)), "field": .string(p.field), "start": .number(Double(start)),
                            "end": .number(Double(end)), "quote": quote]
    let (anchor, _) = try Anchors.check(w.c, text: w.text, input: input, docId: p.documentId, passage: p)
    return Span(passageId: pid, start: anchor.start, end: anchor.end, role: role, anchor: anchor, detail: nil,
                synthetic: target.synthetic)
  }

  static func insertEvidence(_ w: WriteContext, relationship: Int64, _ span: Span, actor: String) throws -> Int64 {
    let id = try w.ids.next("relationship_evidence", w.scope)
    let s = try w.c.prepared(ProvenanceSQL.insertEvidence)
    var detailText: String?
    if let d = span.detail {  // JSON.stringify({locator, quote?}) in the reference's key order
      detailText = "{\"locator\":\(CanonicalJSON.quote(d["locator"]?.stringValue ?? ""))"
        + (d["quote"]?.stringValue.map { ",\"quote\":\(CanonicalJSON.quote($0))" } ?? "") + "}"
    }
    try s.bind(.int(id), .int(relationship), .integer(span.passageId), .text(span.role), .integer(span.start.map(Int64.init)),
               .integer(span.end.map(Int64.init)), .string(span.anchor?.jsonText), .string(detailText), .text(actor), .text(w.at))
    try s.run()
    return id
  }

  // MARK: rows

  struct Row {
    let id: Int64
    let relType: String
    let srcType: String
    let srcRef: String
    let dstType: String
    let dstRef: String
    let directed: Int
    let evidenceStatus: String
    let origin: String
    let sourceDataset: String?
    let sourceLocator: String?
    let provenanceQuality: String
    let method: String?
    let runId: Int64?
    let createdBy: String
    let reviewStatus: String
    let score: Double?
    let scoreKind: String?
    let dateConflict: Int
    let srcYear: Int?
    let dstYear: Int?
    let groupId: Int64?
    let license: String?
    let attribution: String?
    let provenanceNote: String?
    let isSynthetic: Int
    let currentRev: Int
    let createdAt: String
  }

  static func readRow(_ r: ScrollsStore.Row) -> Row {
    Row(id: r.int(0), relType: r.text(1), srcType: r.text(2), srcRef: r.text(3), dstType: r.text(4), dstRef: r.text(5),
        directed: Int(r.int(6)), evidenceStatus: r.text(7), origin: r.text(8), sourceDataset: r.textOrNil(9),
        sourceLocator: r.textOrNil(10), provenanceQuality: r.text(11), method: r.textOrNil(12), runId: r.intOrNil(13),
        createdBy: r.text(14), reviewStatus: r.text(15), score: r.doubleOrNil(16), scoreKind: r.textOrNil(17),
        dateConflict: Int(r.int(18)), srcYear: r.intOrNil(19).map(Int.init), dstYear: r.intOrNil(20).map(Int.init),
        groupId: r.intOrNil(21), license: r.textOrNil(22), attribution: r.textOrNil(23), provenanceNote: r.textOrNil(24),
        isSynthetic: Int(r.int(25)), currentRev: Int(r.int(26)), createdAt: r.text(27))
  }

  /// `relationshipRow(db, id)`: rows of a run that has not succeeded do not exist for readers or reviewers; rows of a
  /// superseded run stay reachable (saved views pin them). 404 otherwise.
  static func row(_ c: Connection, _ id: String) throws -> Row {
    let n = JSNumber.parse(id)
    if JSNumber.isSafeInteger(n), n > 0,
      let r = try c.prepared(ProvenanceSQL.relationshipVisible).bindingFirst([.int(Int64(n))], readRow)
    {
      return r
    }
    throw ProvenanceError.notFound("No relationship \(id).")
  }

  /// `appendRelRevision`: append a relationship_revision and move current_rev (and review_status). → the new rev.
  @discardableResult
  static func appendRevision(_ w: WriteContext, _ rel: Row, actor: String, action: String, before: JSONValue? = nil,
                             after: JSONValue, reason: String? = nil, annotationId: Int64? = nil, reviewStatus: String? = nil) throws -> Int {
    let rev = rel.currentRev + 1
    let id = try w.ids.nextLog("relationship_revision")
    let s = try w.c.prepared(ProvenanceSQL.insertRelRevision)
    try s.bind(.int(id), .int(rel.id), .int(Int64(rev)), .text(actor), .text(w.at), .text(action),
               .string(before.map(CanonicalJSON.string)), .text(CanonicalJSON.string(after)), .string(reason), .integer(annotationId))
    try s.run()
    if let reviewStatus {
      let up = try w.c.prepared(ProvenanceSQL.setRelRevAndReview)
      try up.bind(.int(Int64(rev)), .text(reviewStatus), .int(rel.id))
      try up.run()
    } else {
      let up = try w.c.prepared(ProvenanceSQL.setRelRev)
      try up.bind(.int(Int64(rev)), .int(rel.id))
      try up.run()
    }
    return rev
  }

  // MARK: POST /api/relationships

  /// A human-proposed relationship: the engine forces evidence_status 'proposed' and origin 'human' whatever the request
  /// says; a person never creates documented or computed links (D7).
  /// → `{id, evidence_status: 'proposed', origin: 'human', hypothesis_group, date_conflict, note?}`
  public static func propose(_ w: WriteContext, _ request: JSONValue) throws -> JSONValue {
    guard let body = request.objectValue else { throw ProvenanceError.invalid("Send a JSON object.", field: nil) }
    let author = try Refs.authorName(body["author"])
    let actor = Refs.humanActor(author)
    let relTypeValue = body["rel_type"] ?? .null
    guard let code = relTypeValue.stringValue, let type = Vocab.relTypeByCode[code] else {
      throw ProvenanceError.invalid("Unknown relationship type '\(Anchors.jsString(relTypeValue))'.", field: "rel_type")
    }
    guard let srcRaw = body["src"]?.stringValue, let dstRaw = body["dst"]?.stringValue else {
      throw ProvenanceError.invalid("src and dst are references like passage:901.", field: "src")
    }
    let src = try Refs.resolve(w.c, string: srcRaw), dst = try Refs.resolve(w.c, string: dstRaw)
    for (end, r, raw) in [("src", src, srcRaw), ("dst", dst, dstRaw)] {
      guard let r else {
        throw ProvenanceError.notFound("No \(raw).", hint: "Link existing passages, documents, occurrences, expressions, clusters or etymons.",
                                       field: end)
      }
      if !endpointTypes.contains(r.type) { throw ProvenanceError.invalid("A relationship cannot point at a \(r.type).", field: end) }
    }
    guard let src, let dst else { throw ProvenanceError.invalid("src and dst are references like passage:901.", field: "src") }
    if src.type == dst.type && src.ref == dst.ref { throw ProvenanceError.invalid("A relationship needs two different items.", field: "dst") }
    let note = try Refs.checkNote(body["note"])!
    guard let evidence = body["evidence"]?.arrayValue, !evidence.isEmpty else {
      throw ProvenanceError.invalid("A proposed link needs at least one evidence span.", field: "evidence",
                                    hint: "Select the words that support it, then propose again.")
    }
    if evidence.count > 50 { throw ProvenanceError.invalid("At most 50 evidence spans per request.", field: "evidence") }

    let spans = try evidence.map { try checkSpan(w, $0) }
    var groupId: Int64?
    if let g = body["group"], !g.isNull {
      let gid = Annotations.jsNumber(g)
      guard let row = try w.c.prepared(ProvenanceSQL.groupById).bindingFirst([.double(gid)], {
        (id: $0.int(0), type: $0.text(1), ref: $0.text(2))
      }) else {
        throw ProvenanceError.notFound("No hypothesis group \(Anchors.jsString(g)).", field: "group")
      }
      if row.type != src.type || row.ref != src.ref {
        throw ProvenanceError.invalid(
          "A hypothesis in group \(row.id) must start at \(row.type):\(row.ref) (the item whose source is asked about).", field: "src",
          hint: "Use the group target as src and the proposed source as dst.")
      }
      groupId = row.id
    }
    // a date conflict only when the dates make the stated order impossible (later item certainly earlier)
    var conflict = 0
    if type.requiresPrecedence != 0, let sh = src.yHi, let dl = dst.yLo, sh < dl { conflict = 1 }
    let synthetic = src.synthetic != 0 || dst.synthetic != 0 || spans.contains { $0.synthetic != 0 } ? 1 : 0
    let id = try w.ids.next("relationship", w.scope)
    let ins = try w.c.prepared(ProvenanceSQL.insertHumanRelationship)
    try ins.bind(.int(id), .text(type.code), .text(src.type), .text(src.ref), .text(dst.type), .text(dst.ref), .int(Int64(type.directed)),
                 .text(actor), .int(Int64(conflict)), .integer(src.yLo), .integer(dst.yLo), .integer(groupId), .text(note),
                 .int(Int64(synthetic)), .text(w.at))
    try ins.run()
    let evIds = try spans.map { try insertEvidence(w, relationship: id, $0, actor: actor) }
    let revId = try w.ids.nextLog("relationship_revision")
    let rev = try w.c.prepared(ProvenanceSQL.insertCreateRevision)
    let after: JSONValue = [
      "rel_type": .string(type.code), "src": .string("\(src.type):\(src.ref)"), "dst": .string("\(dst.type):\(dst.ref)"),
      "evidence_status": "proposed", "origin": "human", "evidence": .array(evIds.map { .number(Double($0)) }),
      "hypothesis_group": groupId.map { .number(Double($0)) } ?? .null,
    ]
    try rev.bind(.int(revId), .int(id), .text(actor), .text(w.at), .text(CanonicalJSON.string(after)), .text(note))
    try rev.run()
    var out: JSONObject = ["id": .number(Double(id)), "evidence_status": "proposed", "origin": "human",
                           "hypothesis_group": groupId.map { .number(Double($0)) } ?? .null, "date_conflict": .bool(conflict == 1)]
    let askedStatus = body["evidence_status"].map { !$0.isFalsy && $0 != .string("proposed") } ?? false
    let askedOrigin = body["origin"].map { !$0.isFalsy && $0 != .string("human") } ?? false
    if askedStatus || askedOrigin {
      out["note"] = "A link created by a person is always proposed (origin human); the requested status was not applied."
    }
    return .object(out)
  }

  // MARK: POST /api/relationships/:id/evidence

  /// Attach an evidence span (appends an 'add_evidence' revision; the status never changes). → `{id, relationship, revision}`
  public static func attachEvidence(_ w: WriteContext, id: String, _ request: JSONValue) throws -> JSONValue {
    guard let body = request.objectValue else { throw ProvenanceError.invalid("Send a JSON object.", field: nil) }
    let actor = Refs.humanActor(try Refs.authorName(body["author"]))
    let note = try Refs.checkNote(body["note"])!
    let rel = try row(w.c, id)
    let span = try checkSpan(w, request, field: "role")
    let evId = try insertEvidence(w, relationship: rel.id, span, actor: actor)
    let quote = span.anchor?.quote ?? span.detail?["quote"]?.stringValue
    let rev = try appendRevision(w, rel, actor: actor, action: "add_evidence", after: [
      "evidence_id": .number(Double(evId)), "role": .string(span.role),
      "passage": span.passageId.map { .number(Double($0)) } ?? .null, "start": span.start.map { .number(Double($0)) } ?? .null,
      "end": span.end.map { .number(Double($0)) } ?? .null, "quote": quote.map(JSONValue.string) ?? .null,
      "locator": span.detail?["locator"] ?? .null,
    ], reason: note)
    return ["id": .number(Double(evId)), "relationship": .number(Double(rel.id)), "revision": .number(Double(rev))]
  }

  // MARK: reviews

  static let reviewActions = ["confirm", "reject", "dispute"]
  static let annotationFor: [String: (kind: String, stance: String)] = [
    "confirm": ("evidence_for", "supports"), "reject": ("evidence_against", "contradicts"),
    "dispute": ("evidence_against", "alternative"),
  ]

  /// Review status from each reviewer's latest decision: disputed when anyone disputes or when confirmations and
  /// rejections coexist; confirmed when there are only confirmations; rejected when only rejections.
  public static func reviewStatusOf(_ revisions: [(actor: String, action: String)]) -> String {
    var latest: [(String, String)] = []
    for r in revisions {
      if reviewActions.contains(r.action) {
        if let i = latest.firstIndex(where: { $0.0 == r.actor }) { latest[i].1 = r.action } else { latest.append((r.actor, r.action)) }
      } else if r.action == "retract" {
        latest.removeAll { $0.0 == r.actor }
      }
    }
    var confirms = 0, rejects = 0, disputes = 0
    for (_, a) in latest {
      if a == "confirm" { confirms += 1 } else if a == "reject" { rejects += 1 } else { disputes += 1 }
    }
    if disputes > 0 || (confirms > 0 && rejects > 0) { return "disputed" }
    if confirms > 0 { return "confirmed" }
    if rejects > 0 { return "rejected" }
    return "unreviewed"
  }

  /// POST /api/relationships/:id/review {action, note (≥ 10 characters), author?}.
  /// → `{review_status, revision, annotation_id, evidence_status}`
  public static func review(_ w: WriteContext, id: String, _ request: JSONValue) throws -> JSONValue {
    guard let body = request.objectValue else { throw ProvenanceError.invalid("Send a JSON object.", field: nil) }
    guard let action = body["action"]?.stringValue, reviewActions.contains(action) else {
      throw ProvenanceError.invalid("action must be one of \(reviewActions.joined(separator: ", ")).", field: "action")
    }
    let note = try Refs.checkNote(body["note"])!
    let author = try Refs.authorName(body["author"])
    let actor = Refs.humanActor(author)
    let rel = try row(w.c, id)
    let (kind, stance) = annotationFor[action]!
    let ann = try Annotations.create(w, [
      "target": ["type": "relationship", "ref": .string(String(rel.id))], "kind": .string(kind), "stance": .string(stance),
      "body_md": .string(note), "author": .string(author),
    ])
    let annId = Int64(ann["id"]?.numberValue ?? 0)
    let revs = try w.c.prepared(ProvenanceSQL.relRevisionActions).bindingFirstAll([.int(rel.id)]) { ($0.text(0), $0.text(1)) }
    let next = reviewStatusOf(revs.map { (actor: $0.0, action: $0.1) } + [(actor: actor, action: action)])
    let rev = try appendRevision(w, rel, actor: actor, action: action, before: ["review_status": .string(rel.reviewStatus)],
                                 after: ["review_status": .string(next)], reason: note, annotationId: annId, reviewStatus: next)
    let evidence = try w.c.prepared(ProvenanceSQL.relEvidenceStatus).bindingFirst([.int(rel.id)]) { $0.text(0) } ?? rel.evidenceStatus
    return ["review_status": .string(next), "revision": .number(Double(rev)), "annotation_id": .number(Double(annId)),
            "evidence_status": .string(evidence)]
  }

  // MARK: GET /api/relationships/:id

  static func endpointCard(_ c: Connection, type: String, ref: String, year: Int?) throws -> JSONValue {
    let r = try Refs.resolve(c, type: type, id: ref)
    var out: JSONObject = ["ref": .string("\(type):\(ref)"), "type": .string(type),
                           "y": (year ?? r?.yLo).map { .number(Double($0)) } ?? .null]
    if let r, let doc = r.docId {
      out["doc"] = r.title.map(JSONValue.string) ?? .null
      out["doc_id"] = .number(Double(doc))
      out["label"] = r.dateLabel.map(JSONValue.string) ?? .null
    } else if let title = r?.title {
      out["label"] = .string(title)
    }
    if r == nil { out["missing"] = true }
    return .object(out)
  }

  static func statusWords(_ r: Row) -> String {
    if r.evidenceStatus == "documented" && r.provenanceQuality == "source_unrecorded" { return statusWords["documented_unrecorded"]! }
    return statusWords[r.evidenceStatus] ?? r.evidenceStatus
  }

  static func parsed(_ s: String?) -> JSONValue { s.flatMap { try? JSONValue.parse($0) } ?? .null }

  /// The edge card (§2.C): type and direction, status in words, origin, method or annotator, run, score with its kind,
  /// locator, evidence spans, revisions (compact create revisions expanded), review state, annotations and the caution.
  public static func card(_ c: Connection, id: String) throws -> JSONValue {
    let r = try row(c, id)
    let type = Vocab.relTypeByCode[r.relType]
    let evidence = try c.prepared(ProvenanceSQL.evidenceOf).bindingFirstAll([.int(r.id)]) { e -> JSONValue in
      let anchor = parsed(e.textOrNil(5)), detail = parsed(e.textOrNil(6))
      let quote = anchor["quote"].nonNull ?? detail["quote"].nonNull ?? .null
      return [
        "id": .number(Double(e.int(0))), "role": .string(e.text(1)),
        "passage": e.intOrNil(2).map { .number(Double($0)) } ?? .null, "start": e.intOrNil(3).map { .number(Double($0)) } ?? .null,
        "end": e.intOrNil(4).map { .number(Double($0)) } ?? .null, "quote": quote, "anchor": anchor, "detail": detail,
        "added_by": .string(e.text(7)), "added_at": .string(e.text(8)),
      ]
    }
    let revisions = try c.prepared(ProvenanceSQL.revisionsOfRelationship).bindingFirstAll([.int(r.id)]) { v in
      (rev: v.int(0), action: v.text(1), actor: v.text(2), at: v.text(3), reason: v.textOrNil(4), annotation: v.intOrNil(5),
       before: v.textOrNil(6), after: v.text(7))
    }.map { v -> JSONValue in
      [
        "rev": .number(Double(v.rev)), "action": .string(v.action), "actor": .string(v.actor), "at": .string(v.at),
        "reason": v.reason.map(JSONValue.string) ?? .null, "annotation_id": v.annotation.map { .number(Double($0)) } ?? .null,
        "before": parsed(v.before), "after": (try? CompactRevisions.expanded(v.after, relationship: r.id, on: c)) ?? parsed(v.after),
      ]
    }
    let annotations = try c.prepared(ProvenanceSQL.annotationsOfRelationship).bindingFirstAll([.text(String(r.id))]) {
      JSONValue.number(Double($0.int(0)))
    }
    let cue = evidence.first { $0["role"]?.stringValue == "citation_cue" }
    var card: JSONObject = [
      "id": .number(Double(r.id)), "rel_type": .string(r.relType), "label": .string(type?.label ?? r.relType),
      "inverse_label": type.map { .string($0.inverseLabel) } ?? .null, "glyph": type.map { .string($0.glyph) } ?? .null,
      "family": .string(type?.family ?? "similarity"), "directed": .bool(r.directed == 1),
      "evidence_status": .string(r.evidenceStatus), "status_words": .string(statusWords(r)), "origin": .string(r.origin),
      "created_by": .string(r.createdBy), "method": r.method.map(JSONValue.string) ?? .null,
      "run_id": r.runId.map { .number(Double($0)) } ?? .null, "source_dataset": r.sourceDataset.map(JSONValue.string) ?? .null,
      "source_locator": r.sourceLocator.map(JSONValue.string) ?? .null,
      "locator_external": .bool(r.sourceLocator.map { $0.hasPrefix("http://") || $0.hasPrefix("https://") } ?? false),
      "provenance_quality": .string(r.provenanceQuality), "provenance_note": r.provenanceNote.map(JSONValue.string) ?? .null,
      "review_status": .string(r.reviewStatus),
      "score": r.score.map { ["value": .number($0), "kind": r.scoreKind.map(JSONValue.string) ?? .null] } ?? .null,
      "score_label": r.score == nil ? .null : (r.scoreKind.flatMap { Copy.scoreKindLabels[$0] }.map(JSONValue.string) ?? .null),
      "hypothesis_group": r.groupId.map { .number(Double($0)) } ?? .null, "date_conflict": .bool(r.dateConflict == 1),
      "license": r.license.map(JSONValue.string) ?? .null, "attribution": r.attribution.map(JSONValue.string) ?? .null,
      "src": try endpointCard(c, type: r.srcType, ref: r.srcRef, year: r.srcYear),
      "dst": try endpointCard(c, type: r.dstType, ref: r.dstRef, year: r.dstYear),
      "evidence": .array(evidence), "revisions": .array(revisions), "annotations": .array(annotations),
      "caution": .string(caution), "created_at": .string(r.createdAt), "synthetic": .bool(r.isSynthetic == 1),
    ]
    if let runId = r.runId,
      let run = try c.prepared(ProvenanceSQL.runSummary).bindingFirst([.int(runId)], {
        (stage: $0.text(0), version: $0.text(1), params: $0.text(2), status: $0.text(3))
      })
    {
      card["run"] = ["id": .number(Double(runId)), "stage": .string(run.stage), "pipeline_version": .string(run.version),
                     "params": parsed(run.params).isNull ? [:] : parsed(run.params), "status": .string(run.status)]
    }
    if let cue { card["cue"] = ["quote": cue["quote"] ?? .null, "referent": "inferred"] }
    return .object(card)
  }
}

// MARK: - hypothesis groups (lineage/hypotheses.mjs)

public enum Hypotheses {
  static let targetTypes = ["passage", "document", "occurrence", "expression", "cluster", "etymon"]
  static let minQuestion = 5, maxQuestion = 500

  static func authorOf(_ createdBy: String) -> String { createdBy.hasPrefix("human:") ? String(createdBy.dropFirst(6)) : createdBy }

  static func labelOf(_ c: Connection, dstType: String, dstRef: String) throws -> String {
    guard let end = try Refs.resolve(c, string: "\(dstType):\(dstRef)") else { return "from \(dstType):\(dstRef)" }
    let what = end.title ?? "\(dstType) \(dstRef)"
    return end.dateLabel.map { "from \(what) (\($0))" } ?? "from \(what)"
  }

  /// GET /api/hypothesis-groups/:id: the group with its hypotheses side by side.
  public static func group(_ c: Connection, id: String) throws -> JSONValue {
    let n = JSNumber.parse(id)
    guard JSNumber.isSafeInteger(n), n > 0,
      let g = try c.prepared(ProvenanceSQL.groupRow).bindingFirst([.int(Int64(n))], {
        (id: $0.int(0), type: $0.text(1), ref: $0.text(2), question: $0.text(3), createdBy: $0.text(4), synthetic: $0.int(5),
         createdAt: $0.text(6))
      })
    else { throw ProvenanceError.notFound("No hypothesis group \(id).") }
    let rels = try c.prepared(ProvenanceSQL.relationshipsOfGroup).bindingFirstAll([.int(g.id)], Relationships.readRow)
    let hypotheses = try rels.map { r -> JSONValue in
      let t = Vocab.relTypeByCode[r.relType]
      let evidence = try c.prepared(ProvenanceSQL.evidenceCount).bindingFirst([.int(r.id)]) { $0.int(0) } ?? 0
      return [
        "rel_id": .number(Double(r.id)), "rel_type": .string(r.relType), "glyph": t.map { .string($0.glyph) } ?? .null,
        "family": t.map { .string($0.family) } ?? .null, "src": .string("\(r.srcType):\(r.srcRef)"),
        "dst": .string("\(r.dstType):\(r.dstRef)"), "label": .string(try labelOf(c, dstType: r.dstType, dstRef: r.dstRef)),
        "evidence_status": .string(r.evidenceStatus), "review_status": .string(r.reviewStatus), "origin": .string(r.origin),
        "author": .string(authorOf(r.createdBy)), "method": r.method.map(JSONValue.string) ?? .null,
        "score": r.score.map { ["value": .number($0), "kind": r.scoreKind.map(JSONValue.string) ?? .null] } ?? .null,
        "evidence": .number(Double(evidence)), "y": r.dstYear.map { .number(Double($0)) } ?? .null,
        "date_conflict": .bool(r.dateConflict == 1), "synthetic": .bool(r.isSynthetic == 1),
      ]
    }
    return [
      "id": .number(Double(g.id)), "question": .string(g.question), "target": .string("\(g.type):\(g.ref)"),
      "created_by": .string(g.createdBy), "created_at": .string(g.createdAt), "hypotheses": .array(hypotheses),
      "text": .string("⚖ \(hypotheses.count) competing"),
      "note": "Confirming one hypothesis does not reject the others; each keeps its own evidence and review status.",
      "synthetic": .bool(g.synthetic == 1),
    ]
  }

  /// POST /api/hypothesis-groups {target, question, relationships?, author?}: open a group on a target. `relationships`
  /// regroups existing links from that target into it (a 'regroup' revision each; their evidence status is untouched).
  /// The same target and question return the existing group. → `{id, existing, regrouped}`
  public static func create(_ w: WriteContext, _ request: JSONValue) throws -> JSONValue {
    guard let body = request.objectValue else { throw ProvenanceError.invalid("Send a JSON object.", field: nil) }
    let question = body["question"]?.stringValue.map(JSString.trim) ?? ""
    if question.utf16.count < minQuestion { throw ProvenanceError.invalid("A hypothesis group needs a question.", field: "question") }
    if question.utf16.count > maxQuestion {
      throw ProvenanceError.invalid("A question may have at most \(maxQuestion) characters.", field: "question")
    }
    guard let targetRaw = body["target"]?.stringValue else {
      throw ProvenanceError.invalid("target must be a reference like passage:2210.", field: "target")
    }
    guard let target = try Refs.resolve(w.c, string: targetRaw) else { throw ProvenanceError.notFound("No \(targetRaw).", field: "target") }
    if !targetTypes.contains(target.type) {
      throw ProvenanceError.invalid("A hypothesis group cannot target a \(target.type).", field: "target")
    }
    let actor = Refs.humanActor(try Refs.authorName(body["author"]))
    let idsValue = body["relationships"].nonNull ?? .array([])
    guard let ids = idsValue.arrayValue,
      ids.allSatisfy({ if case .number(let n) = $0 { return JSNumber.isSafeInteger(n) && n > 0 } else { return false } })
    else { throw ProvenanceError.invalid("relationships must be a list of ids.", field: "relationships") }

    let found = try w.c.prepared(ProvenanceSQL.groupByQuestion).bindingFirst([.text(target.type), .text(target.ref), .text(question)]) {
      $0.int(0)
    }
    let id: Int64
    if let found {
      id = found
    } else {
      id = try w.ids.next("hypothesis_group", w.scope)
      let ins = try w.c.prepared(ProvenanceSQL.insertGroup)
      try ins.bind(.int(id), .text(target.type), .text(target.ref), .text(question), .text(actor),
                   .int(target.synthetic != 0 ? 1 : 0), .text(w.at))
      try ins.run()
    }
    var regrouped: [JSONValue] = []
    for v in ids {
      let relId = Int64(v.numberValue!)
      let rel = try Relationships.row(w.c, String(relId))
      if rel.srcType != target.type || rel.srcRef != target.ref {
        throw ProvenanceError.invalid(
          "Relationship \(relId) does not start at \(target.type):\(target.ref); a hypothesis explains where the target came from.",
          field: "relationships")
      }
      if rel.groupId == id { continue }
      let up = try w.c.prepared(ProvenanceSQL.setRelGroup)
      try up.bind(.int(id), .int(rel.id))
      try up.run()
      try Relationships.appendRevision(w, rel, actor: actor, action: "regroup",
                                       before: ["hypothesis_group": rel.groupId.map { .number(Double($0)) } ?? .null],
                                       after: ["hypothesis_group": .number(Double(id))], reason: question)
      regrouped.append(.number(Double(rel.id)))
    }
    return ["id": .number(Double(id)), "existing": .bool(found != nil), "regrouped": .array(regrouped)]
  }
}
