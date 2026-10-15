// OWNER: N6
// The journaled acts of the notebook (IOS-SPEC §6.2–§6.5): how a live write becomes a `JournalOp` with stable keys, and
// how an op is applied — live, at the launch catch-up, or into a rebuilt generation — through the same code path. Apply
// is deterministic and idempotent by seq: it resolves the op's stable keys to this generation's rows (in the generation
// of the act they resolve to the very ids of the request), then runs the reference's logic with the act's own clock
// (`entry.at`). An act whose anchor no longer resolves is kept as an orphaned interpretation (its row is written with the
// anchor it had), never dropped; an act whose input is missing (a pack, an import) stops the replay with that reason,
// because skipping it would break the prefix property that D17 relies on (§6.4).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

public enum ProvenanceJournal {
  /// The ops this package journals and applies.
  public static func handles(_ op: JournalOp) -> Bool {
    switch op {
    case .annotationCreate, .annotationRevise, .annotationReinterpret, .annotationWithdraw, .relationshipPropose,
      .relationshipReview, .relationshipEvidence, .hypothesisGroupCreate, .dimensionDefine, .clusterLabel, .viewSave,
      .viewDelete:
      true
    default:
      false
    }
  }

  /// What applying one act did.
  public struct Applied: Sendable {
    /// The reference's response body.
    public let response: JSONValue
    /// Anchors that were re-located (offsets or passage changed).
    public let reanchored: Int
    /// Anchors that no longer resolve: the act was kept as an orphaned interpretation.
    public let orphaned: Int
    public init(response: JSONValue, reanchored: Int = 0, orphaned: Int = 0) {
      self.response = response
      self.reanchored = reanchored
      self.orphaned = orphaned
    }
  }

  // MARK: live: request → op (inside the dry run's transaction, after the reference logic accepted the request)

  /// The actor of a human act.
  public static func actor(_ author: JSONValue?) throws -> String { Refs.humanActor(try Refs.authorName(author)) }

  public static func annotationCreateOp(_ w: WriteContext, body: JSONValue, result: JSONValue, journal: [JournalEntry]) throws -> AnnotationCreateOp {
    let type = body["target"]?["type"]?.stringValue ?? ""
    let ref = Refs.refString(body["target"]?["ref"] ?? .null)
    let anchor = result["anchor"].flatMap(anchorValue)
    guard let target = try StableKeys.annotationTarget(w.c, text: w.text, type: type, ref: ref, anchor: anchor, journal: journal) else {
      throw ScrollsError(code: .internalError, message: "The target \(type):\(ref) has no stable key.", status: 500)
    }
    return AnnotationCreateOp(target: target, request: body)
  }

  public static func relationshipProposeOp(_ w: WriteContext, body: JSONValue, result: JSONValue, journal: [JournalEntry]) throws -> RelationshipProposeOp {
    func key(_ s: String?) throws -> EndpointKey {
      guard let s, let r = try Refs.resolve(w.c, string: s), let k = try StableKeys.endpointKey(w.c, text: w.text, type: r.type, ref: r.ref)
      else { throw ScrollsError(code: .internalError, message: "The endpoint \(s ?? "?") has no stable key.", status: 500) }
      return k
    }
    let id = Int64(result["id"]?.numberValue ?? 0)
    let anchors = try w.c.prepared(ProvenanceSQL.evidenceOf).bindingFirstAll([.int(id)]) { $0.textOrNil(5) }
      .compactMap { $0.flatMap { try? JSONValue.parse($0) }.flatMap(anchorValue) }
      .compactMap { try StableKeys.anchorKey(w.c, $0) }
    var group: HypothesisGroupKey?
    if let g = result["hypothesis_group"]?.integer {
      group = try StableKeys.groupKey(w.c, text: w.text, Int64(g), journal: journal)
    }
    return RelationshipProposeOp(src: try key(body["src"]?.stringValue), dst: try key(body["dst"]?.stringValue), group: group,
                                 evidence: anchors, request: body)
  }

  public static func hypothesisGroupCreateOp(_ w: WriteContext, body: JSONValue) throws -> HypothesisGroupCreateOp {
    guard let s = body["target"]?.stringValue, let r = try Refs.resolve(w.c, string: s),
      let k = try StableKeys.endpointKey(w.c, text: w.text, type: r.type, ref: r.ref)
    else { throw ScrollsError(code: .internalError, message: "The group's target has no stable key.", status: 500) }
    return HypothesisGroupCreateOp(target: k, request: body)
  }

  /// The portable cutoffs of a view saved in this generation (IOS-SPEC §6.4).
  public static func portableCutoffs(_ c: Connection, text: any TextStore, saved: Views.Saved, seq: UInt64) throws -> PortableCutoffs {
    var runKeys: [String: RunKey] = [:]
    func add(_ v: JSONValue?) throws {
      guard let id = v?.integer, let k = try StableKeys.runKey(c, Int64(id)) else { return }
      runKeys[String(id)] = k
    }
    for (_, v) in saved.runIds {
      if case .object(let o) = v { for (_, x) in o { try add(x) } } else { try add(v) }
    }
    var strands: [String: ExprKey] = [:]
    for s in saved.state["strands"]?.arrayValue ?? [] where s["type"]?.stringValue == "expression" {
      if let id = s["id"]?.integer, let k = try StableKeys.exprKey(c, Int64(id)) { strands["e\(id)"] = k }
    }
    var selection: PortableSelection?
    if let sel = saved.state["selection"], let type = sel["type"]?.stringValue, let id = sel["id"]?.integer {
      selection = try portableSelection(c, text: text, type: type, id: Int64(id))
    }
    let packs = c.profile == .device ? try c.prepared(ProvenanceSQL.packsInstalled).all { $0.text(0) } : []
    return PortableCutoffs(generation: try Meta.get(c, "generation") ?? "reference", journalSeq: seq, runKeys: runKeys,
                           strands: strands, selection: selection, packs: packs)
  }

  static func portableSelection(_ c: Connection, text: any TextStore, type: String, id: Int64) throws -> PortableSelection? {
    switch type {
    case "occurrence":
      if case .occurrence(let e, let a)? = try StableKeys.endpointKey(c, text: text, type: "occurrence", ref: String(id)) {
        return .occurrence(expr: e, anchor: a)
      }
    case "passage":
      return try StableKeys.passageKey(c, text: text, id).map { .passage(anchor: $0) }
    case "cluster":
      return try StableKeys.clusterKey(c, id).map { .cluster(key: $0) }
    case "document":
      return try StableKeys.docKey(c, id).map { .document(key: $0) }
    case "relationship":
      return .relationship(key: try StableKeys.relKey(c, text: text, id))
    default:
      break
    }
    return nil
  }

  static func anchorValue(_ v: JSONValue) -> AnchorValue? {
    guard let sha = v["sha256"]?.stringValue, let field = v["field"]?.stringValue, let s = v["start"]?.integer,
      let e = v["end"]?.integer, let q = v["quote"]?.stringValue
    else { return nil }
    return AnchorValue(docId: v["doc_id"]?.integer.map(Int64.init), sha256: sha, field: field, start: s, end: e, quote: q,
                       prefix: v["prefix"]?.stringValue ?? "", suffix: v["suffix"]?.stringValue ?? "")
  }

  // MARK: apply

  /// Applies `entry` in this generation (the caller's write transaction; the caller records `journal_applied`).
  /// Throws `StableKeys.Unresolved.missing` when an input of the act is not in this atlas (the replay waits), and the
  /// reference's ScrollsError when the act is refused here as it was when it was made.
  public static func apply(_ entry: JournalEntry, _ w: WriteContext, journal: [JournalEntry]) throws -> Applied {
    let author: JSONValue? = entry.actor.hasPrefix("human:") ? .string(String(entry.actor.dropFirst(6))) : nil
    switch entry.op {
    case .annotationCreate(let op):
      let (body, moved, orphan) = try remapAnnotationBody(w, op, journal: journal)
      if let orphan { return Applied(response: try insertOrphan(w, op, body: body, reason: orphan), orphaned: 1) }
      do {
        let r = try Annotations.create(w, body)
        return Applied(response: r, reanchored: moved || r["relocated"] != nil ? 1 : 0)
      } catch let e as ScrollsError where isAnchorLoss(e) {
        return Applied(response: try insertOrphan(w, op, body: body, reason: e.message), orphaned: 1)
      }
    case .annotationRevise(let key, let patch):
      let id = try annotation(w, key)
      return Applied(response: try Annotations.revise(w, id: String(id), try ScrollsJSON.value(patch)))
    case .annotationReinterpret(let key, let op):
      let id = try annotation(w, key)
      let (body, moved, orphan) = try remapAnnotationBody(w, op, journal: journal)
      if let orphan { throw StableKeys.Unresolved.orphaned(orphan) }
      return Applied(response: try Annotations.reinterpret(w, id: String(id), body), reanchored: moved ? 1 : 0)
    case .annotationWithdraw(let key, let reason):
      let id = try annotation(w, key)
      var body = JSONObject()
      if !reason.isEmpty { body["reason"] = .string(reason) }
      if let author { body["author"] = author }
      return Applied(response: try Annotations.withdraw(w, id: String(id), .object(body)))
    case .relationshipPropose(let op):
      let (body, moved) = try remapProposal(w, op, journal: journal)
      return Applied(response: try Relationships.propose(w, body), reanchored: moved)
    case .relationshipReview(let key, let review):
      guard let id = try StableKeys.relId(w.c, text: w.text, key) else { throw StableKeys.Unresolved.missing("the relationship it reviews") }
      return Applied(response: try Relationships.review(w, id: String(id), try ScrollsJSON.value(review)))
    case .relationshipEvidence(let key, let ev):
      guard let id = try StableKeys.relId(w.c, text: w.text, key) else { throw StableKeys.Unresolved.missing("the relationship it supports") }
      return Applied(response: try Relationships.attachEvidence(w, id: String(id), try ScrollsJSON.value(ev)))
    case .hypothesisGroupCreate(let op):
      var body = op.request.objectValue ?? JSONObject()
      switch try StableKeys.resolveEndpoint(w.c, text: w.text, op.target) {
      case .success(let t): body["target"] = .string("\(t.0):\(t.1)")
      case .failure(let u): throw u
      }
      return Applied(response: try Hypotheses.create(w, .object(body)))
    case .dimensionDefine(let op):
      if try w.c.prepared(ProvenanceSQL.dimensionDef).bindingFirst([.text(op.key)], { _ in true }) == nil {
        let s = try w.c.prepared(ProvenanceSQL.insertDimension)
        try s.bind(.text(op.key), .text(op.label), .text(op.type), .string(op.options.map(CanonicalJSON.string)), .text(entry.actor))
        try s.run()
      }
      return Applied(response: ["key": .string(op.key)])
    case .clusterLabel(let key, let label):
      guard let id = try StableKeys.clusterId(w.c, key) else { throw StableKeys.Unresolved.missing("the context groups it labels") }
      var body: JSONObject = ["target": ["type": "cluster", "ref": .string(String(id))], "kind": "label", "body_md": .string(label)]
      if let author { body["author"] = author }
      return Applied(response: try Annotations.create(w, .object(body)))
    case .viewSave(let request, let portable):
      let saved = try Views.save(w, try ScrollsJSON.value(request))
      if w.c.profile == .device {
        var p = portable
        p.journalSeq = entry.seq
        let s = try w.c.prepared(ProvenanceSQL.insertPortable)
        try s.bind(.int(saved.viewId), .text(CanonicalJSON.string(try ScrollsJSON.value(p))), .text(w.at))
        try s.run()
      }
      return Applied(response: saved.response)
    case .viewDelete(let slug):
      try Views.delete(w, slug: slug)
      return Applied(response: .null)
    default:
      throw StableKeys.Unresolved.missing("the replay handler of '\(entry.op.name)' (another package's act)")
    }
  }

  /// The anchored words are gone (checkAnchor's not_found, ambiguous, outside_passage, no_text).
  static func isAnchorLoss(_ e: ScrollsError) -> Bool {
    e.code == .validation && e.detail["field"]?.stringValue == "anchor"
      && ["not_found", "ambiguous", "outside_passage", "no_text"].contains(e.detail["reason"]?.stringValue ?? "")
  }

  static func annotation(_ w: WriteContext, _ key: AnnotationKey) throws -> Int64 {
    guard let id = try StableKeys.annotationId(w.c, key) else { throw StableKeys.Unresolved.missing("the annotation it edits") }
    return id
  }

  /// The request of an annotationCreate with its target (and anchor document) mapped to this generation. Returns the
  /// orphan reason when the anchored words are gone.
  static func remapAnnotationBody(_ w: WriteContext, _ op: AnnotationCreateOp, journal: [JournalEntry]) throws
    -> (body: JSONValue, moved: Bool, orphan: String?)
  {
    var body = op.request.objectValue ?? JSONObject()
    var target = body["target"]?.objectValue ?? JSONObject()
    let oldRef = Refs.refString(target["ref"] ?? .null)
    var newRef = oldRef
    var anchorDoc: Int64?
    switch op.target {
    case .endpoint(let key):
      switch try StableKeys.resolveEndpoint(w.c, text: w.text, key) {
      case .success(let r): newRef = r.1
      case .failure(.orphaned(let reason)): return (.object(body), false, reason)
      case .failure(let u): throw u
      }
      switch key {
      case .passage(let a), .occurrence(_, let a):
        guard let d = try StableKeys.docId(w.c, a.doc) else { throw StableKeys.Unresolved.missing("document \(a.doc.collection):\(a.doc.extId)") }
        anchorDoc = d
      case .document(let d):
        anchorDoc = try StableKeys.docId(w.c, d)
      default: break
      }
    case .relationship(let key):
      guard let id = try StableKeys.relId(w.c, text: w.text, key) else { throw StableKeys.Unresolved.missing("the relationship it is about") }
      newRef = String(id)
    case .hypothesisGroup(let key):
      guard let id = try StableKeys.groupId(w.c, text: w.text, key, journal: journal) else { throw StableKeys.Unresolved.missing("the hypothesis group") }
      newRef = String(id)
    case .savedView(let slug):
      newRef = slug
    case .timeWindow(let run, let label):
      guard let runId = try StableKeys.runId(w.c, run),
        let id = try w.c.prepared(ProvenanceSQL.timeWindowByKey).bindingFirst([.int(runId), .text(label)], { $0.int(0) })
      else { throw StableKeys.Unresolved.missing("the time window '\(label)'") }
      newRef = String(id)
    case .annotation(let key):
      newRef = String(try annotation(w, key))
    }
    target["ref"] = .string(newRef)
    body["target"] = .object(target)
    var moved = newRef != oldRef
    if let doc = anchorDoc, case .object(var a)? = body["anchor"] {
      if a["doc_id"]?.integer.map(Int64.init) != doc { moved = true }
      a["doc_id"] = .number(Double(doc))
      body["anchor"] = .object(a)
    }
    return (.object(body), moved, nil)
  }

  /// An interpretation whose words are gone in this generation: written with the anchor it had, never dropped (§6.5).
  static func insertOrphan(_ w: WriteContext, _ op: AnnotationCreateOp, body: JSONValue, reason: String) throws -> JSONValue {
    let author = try Refs.authorName(body["author"])
    let type = body["target"]?["type"]?.stringValue ?? "passage"
    var anchorText: String?
    if case .endpoint(let key) = op.target {
      switch key {
      case .passage(let a), .occurrence(_, let a):
        let doc = try StableKeys.docId(w.c, a.doc)
        anchorText = AnchorValue(docId: doc, sha256: a.originalSha256, field: a.field, start: a.start, end: a.end, quote: a.quote,
                                 prefix: a.prefix, suffix: a.suffix).jsonText
      default: break
      }
    }
    let id = try w.ids.next("annotation", w.scope)
    let s = try w.c.prepared(ProvenanceSQL.insertAnnotation)
    try s.bind(.int(id), .text(type), .text(Refs.refString(body["target"]?["ref"] ?? .null)), .string(anchorText),
               .text(body["kind"]?.stringValue ?? "interpretation"), .text(author),
               .string(body["layer"]?.stringValue.map(JSString.trim)), .null, .int(0), .text(w.at))
    try s.run()
    try Annotations.insertRevision(w, annotation: id, rev: 1, .init(
      body: body["body_md"]?.stringValue ?? "", stance: body["stance"]?.stringValue, dimensions: body["dimensions"].nonNull ?? [:],
      tags: (body["tags"]?.arrayValue ?? []).compactMap(\.stringValue), refs: [], reason: "orphaned: \(reason)", author: author))
    return ["id": .number(Double(id)), "rev": 1, "orphaned": .string(reason)]
  }

  /// A proposal with its endpoints, evidence spans and group mapped to this generation. → (body, spans re-anchored)
  static func remapProposal(_ w: WriteContext, _ op: RelationshipProposeOp, journal: [JournalEntry]) throws -> (JSONValue, Int) {
    var body = op.request.objectValue ?? JSONObject()
    for (name, key) in [("src", op.src), ("dst", op.dst)] {
      switch try StableKeys.resolveEndpoint(w.c, text: w.text, key) {
      case .success(let r): body[name] = .string("\(r.0):\(r.1)")
      case .failure(let u): throw u
      }
    }
    if let g = op.group {
      guard let id = try StableKeys.groupId(w.c, text: w.text, g, journal: journal) else { throw StableKeys.Unresolved.missing("the hypothesis group") }
      body["group"] = .number(Double(id))
    }
    var moved = 0
    var anchors = op.evidence.makeIterator()
    if let spans = body["evidence"]?.arrayValue {
      body["evidence"] = .array(try spans.map { span -> JSONValue in
        guard var o = span.objectValue, (o["role"]?.stringValue ?? "supporting") != "external_record" else { return span }
        guard let a = anchors.next() else { return span }
        switch try StableKeys.resolve(w.c, text: w.text, a) {
        case .missingDocument(let d): throw StableKeys.Unresolved.missing("document \(d.collection):\(d.extId)")
        case .orphaned(let reason): throw StableKeys.Unresolved.orphaned(reason)
        case .found(let n, _):
          guard let doc = n.docId, let p = try Anchors.passageFor(w.c, doc: doc, field: n.field, start: n.start, end: n.end) else {
            throw StableKeys.Unresolved.orphaned("no passage covers the words")
          }
          if o["passage"].map(Annotations.jsNumber) != Double(p.id) || o["relative"] == .bool(true) || o["start"]?.integer != n.start {
            moved += 1
          }
          o["passage"] = .number(Double(p.id))
          o["start"] = .number(Double(n.start))
          o["end"] = .number(Double(n.end))
          o["relative"] = nil
          o["quote"] = nil
          return .object(o)
        }
      })
    }
    return (.object(body), moved)
  }

  // MARK: replay

  /// What a replay did (`ReplayReport` in ScrollsService).
  public struct ReplayOutcome: Sendable, Equatable {
    public var fromSeq: UInt64
    public var toSeq: UInt64
    public var resolved = 0
    public var reanchored = 0
    public var orphaned = 0
    /// Acts refused here as they were when they were made (a validation error is deterministic).
    public var refused = 0
    public var waiting: (seq: UInt64, reason: String, remaining: Int)?

    public static func == (a: ReplayOutcome, b: ReplayOutcome) -> Bool {
      a.fromSeq == b.fromSeq && a.toSeq == b.toSeq && a.resolved == b.resolved && a.reanchored == b.reanchored
        && a.orphaned == b.orphaned && a.refused == b.refused && a.waiting?.seq == b.waiting?.seq
        && a.waiting?.reason == b.waiting?.reason && a.waiting?.remaining == b.waiting?.remaining
    }
  }

  /// Applies `entries` with seq > `meta.journal_applied_seq`, strictly in seq order, each in one transaction that also
  /// records it as applied. `foreign` applies another package's act (nil: there is no handler in this build, and the
  /// replay waits there). Stops at the first act whose input is missing.
  public static func replay(_ entries: [JournalEntry], writer: Writer, text: any TextStore,
                            foreign: (@Sendable (JournalEntry, WriteTx) throws -> Bool)? = nil) async throws -> ReplayOutcome {
    let applied = try await writer.write("journal applied seq") { tx in
      UInt64(try Meta.get(tx.connection, "journal_applied_seq") ?? "0") ?? 0
    }
    let pending = entries.filter { $0.seq > applied }.sorted { $0.seq < $1.seq }
    var out = ReplayOutcome(fromSeq: applied + 1, toSeq: applied)
    for (i, e) in pending.enumerated() {
      do {
        if handles(e.op) {
          let r = try await writer.write("replay \(e.seq) \(e.op.name)") { tx in
            let w = WriteContext(tx: tx, text: text, at: e.at)
            let r = try apply(e, w, journal: entries)
            try tx.recordJournalApplied(e)
            return r
          }
          out.resolved += 1
          out.reanchored += r.reanchored
          out.orphaned += r.orphaned
        } else if let foreign {
          let done = try await writer.write("replay \(e.seq) \(e.op.name)") { tx in
            guard try foreign(e, tx) else { return false }
            try tx.recordJournalApplied(e)
            return true
          }
          guard done else {
            out.waiting = (e.seq, "the \(e.op.name) act (seq \(e.seq)) has no replay handler in this build", pending.count - i - 1)
            return out
          }
          out.resolved += 1
        } else {
          out.waiting = (e.seq, "the \(e.op.name) act (seq \(e.seq)) has no replay handler in this build", pending.count - i - 1)
          return out
        }
      } catch let u as StableKeys.Unresolved {
        switch u {
        case .missing:
          out.waiting = (e.seq, "the \(e.op.name) act (seq \(e.seq)) \(u.description)", pending.count - i - 1)
          return out
        case .orphaned:
          // an act on words that are gone and that cannot be kept as an orphan row (a re-reading or a link): refused here
          try await writer.write("replay \(e.seq) orphaned") { tx in try tx.recordJournalApplied(e) }
          out.orphaned += 1
        }
      } catch let err as ScrollsError where (400..<500).contains(err.status ?? 0) {
        // refused as it was when it was made: no rows; the act is marked applied so the catch-up does not retry it
        try await writer.write("replay \(e.seq) refused") { tx in try tx.recordJournalApplied(e) }
        out.refused += 1
      }
      out.toSeq = e.seq
    }
    return out
  }

  /// Every entry of a journal, in order.
  public static func entries(_ journal: JournalFile, after seq: UInt64 = 0) async throws -> [JournalEntry] {
    var out: [JournalEntry] = []
    for try await e in journal.entries(after: seq) { out.append(e) }
    return out
  }
}
