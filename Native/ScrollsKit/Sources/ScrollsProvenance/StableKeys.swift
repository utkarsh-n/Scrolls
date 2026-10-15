// OWNER: N6
// Stable keys (IOS-SPEC §6.3): how a journal op names its rows so that replaying the journal into any generation finds
// the same rows. A key is computed from the row when the act is journaled, and resolved back to a row id when the act is
// applied — live (where it resolves to the very ids of the request) or in a replay (where ids may differ).
//   DocKey        collection slug : ext_id
//   PassageAnchor the D18 anchor {doc key, original_sha256, field, start, end, quote, prefix, suffix}
//   ExprKey       (kind, lang, norm, corpus slug)
//   RunKey        (stage, params_hash, input_fingerprint, code_hash)
//   ClusterKey    (RunKey, cluster ordinal)
//   AnnotationKey the seq of the act that created it      HypothesisGroupKey the seq of its hypothesisGroupCreate
//   RelKey        human: the seq of its proposal · computed: (RunKey, src, dst) · documented: hash of its natural key
// Rows that no journal act created (the starter's, a source pack's) are generation-stable by construction: their ids come
// from the source's slot (IOS-SPEC N-11). Their keys carry the id: an AnnotationKey / HypothesisGroupKey seq at or above
// `baseMark` is `baseMark + id`, and a documented RelKey's hash is `<sha256 of the natural key>@<id>`, checked against the
// row on resolution. Which act created a row is read from `journal_applied.max_ids_json` (the largest id of each cutoff
// table after each act): an act created exactly the log rows in (max before it, max after it].

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

public enum StableKeys {
  /// Seqs at and above this name a row no journal act created, by id (`baseMark + id`; below 2⁵³, so exact in JSON).
  public static let baseMark: UInt64 = 1 << 52

  // MARK: documents and anchors

  public static func docKey(_ c: Connection, _ doc: Int64) throws -> DocKey? {
    try c.prepared(ProvenanceSQL.docKey).bindingFirst([.int(doc)]) { DocKey(collection: $0.text(0), extId: $0.text(1)) }
  }

  public static func docId(_ c: Connection, _ key: DocKey) throws -> Int64? {
    try c.prepared(ProvenanceSQL.docByKey).bindingFirst([.text(key.collection), .text(key.extId)]) { $0.int(0) }
  }

  /// The portable form of a server anchor.
  public static func anchorKey(_ c: Connection, _ a: AnchorValue) throws -> PassageAnchor? {
    guard let doc = a.docId, let key = try docKey(c, doc) else { return nil }
    return PassageAnchor(doc: key, originalSha256: a.sha256, field: a.field, start: a.start, end: a.end, quote: a.quote,
                         prefix: a.prefix, suffix: a.suffix)
  }

  /// Where a portable anchor lies in this generation.
  public enum AnchorLookup: Sendable, Equatable {
    /// Found (same offsets or re-located): the anchor in this generation, and the resolution method.
    case found(AnchorValue, method: String)
    /// The document is not in this generation (a pack or an import the replay waits for).
    case missingDocument(DocKey)
    /// The document is here but its words are not (or are ambiguous): an orphaned interpretation.
    case orphaned(reason: String)
  }

  public static func resolve(_ c: Connection, text: any TextStore, _ p: PassageAnchor) throws -> AnchorLookup {
    guard let doc = try docId(c, p.doc) else { return .missingDocument(p.doc) }
    guard let t = try Anchors.loadFieldText(c, text: text, doc: doc, field: p.field) else {
      return .orphaned(reason: "the document has no '\(p.field)' text")
    }
    let loose = LooseAnchor(docId: Int(doc), sha256: p.originalSha256, field: p.field, start: p.start, end: p.end, quote: p.quote,
                            prefix: p.prefix, suffix: p.suffix)
    guard let r = Anchors.resolve(t.units, loose, sha: t.sha) else { return .orphaned(reason: "the quoted words are not in the text") }
    if r.ambiguous { return .orphaned(reason: "the quoted words occur more than once and the offsets do not say which") }
    return .found(try Anchors.make(t.units, field: p.field, start: r.start, end: r.end, docId: doc, sha: t.sha), method: r.method)
  }

  /// A passage as the anchor of its whole span.
  public static func passageKey(_ c: Connection, text: any TextStore, _ passage: Int64) throws -> PassageAnchor? {
    guard let p = try c.prepared(ProvenanceSQL.passageBounds).bindingFirst([.int(passage)], {
      (doc: $0.int(1), field: $0.text(2), start: Int($0.int(3)), end: Int($0.int(4)))
    }), p.start < p.end, let t = try Anchors.loadFieldText(c, text: text, doc: p.doc, field: p.field), p.end <= t.units.count
    else { return nil }
    return try anchorKey(c, try Anchors.make(t.units, field: p.field, start: p.start, end: p.end, docId: p.doc, sha: t.sha))
  }

  /// The passage holding a portable passage anchor in this generation.
  public static func passageId(_ c: Connection, text: any TextStore, _ p: PassageAnchor) throws -> Int64? {
    guard case .found(let a, _) = try resolve(c, text: text, p), let doc = a.docId else { return nil }
    return try Anchors.passageFor(c, doc: doc, field: a.field, start: a.start, end: a.end)?.id
  }

  // MARK: expressions, runs, clusters

  public static func exprKey(_ c: Connection, _ id: Int64) throws -> ExprKey? {
    try c.prepared(ProvenanceSQL.exprKey).bindingFirst([.int(id)]) {
      ExprKey(kind: $0.text(0), lang: $0.textOrNil(1), norm: $0.text(2), corpus: $0.textOrNil(3))
    }
  }

  public static func exprId(_ c: Connection, _ k: ExprKey) throws -> Int64? {
    try c.prepared(ProvenanceSQL.exprByKey).bindingFirst([.text(k.kind), .text(k.lang ?? ""), .text(k.norm), .text(k.corpus ?? "")]) {
      $0.int(0)
    }
  }

  public static func runKey(_ c: Connection, _ id: Int64) throws -> RunKey? {
    try c.prepared(ProvenanceSQL.runKey).bindingFirst([.int(id)]) {
      RunKey(stage: Stage(rawValue: $0.text(0)), paramsHash: $0.text(1), inputFingerprint: $0.text(2), codeHash: $0.text(3))
    }
  }

  public static func runId(_ c: Connection, _ k: RunKey) throws -> Int64? {
    try c.prepared(ProvenanceSQL.runByKey).bindingFirst([.text(k.stage.rawValue), .text(k.paramsHash), .text(k.inputFingerprint),
                                                       .text(k.codeHash)]) { $0.int(0) }
  }

  public static func clusterKey(_ c: Connection, _ id: Int64) throws -> ClusterKey? {
    guard let r = try c.prepared(ProvenanceSQL.clusterKey).bindingFirst([.int(id)], { ($0.int(0), Int($0.int(1))) }),
      let run = try runKey(c, r.0)
    else { return nil }
    return ClusterKey(run: run, ordinal: r.1)
  }

  public static func clusterId(_ c: Connection, _ k: ClusterKey) throws -> Int64? {
    guard let run = try runId(c, k.run) else { return nil }
    return try c.prepared(ProvenanceSQL.clusterByKey).bindingFirst([.int(run), .int(Int64(k.ordinal))]) { $0.int(0) }
  }

  // MARK: endpoints (relationship ends, hypothesis-group targets, annotation targets)

  public static func endpointKey(_ c: Connection, text: any TextStore, type: String, ref: String) throws -> EndpointKey? {
    let n = Refs.intId(ref)
    switch type {
    case "document": return try n.flatMap { try docKey(c, $0) }.map { .document(key: $0) }
    case "passage": return try n.flatMap { try passageKey(c, text: text, $0) }.map { .passage(anchor: $0) }
    case "occurrence":
      guard let n, let o = try c.prepared(ProvenanceSQL.occurrenceRow).bindingFirst([.int(n)], { ($0.int(0), $0.int(1)) }),
        let expr = try exprKey(c, o.0),
        let span = try c.prepared(ProvenanceSQL.occurrenceSpan).bindingFirst([.int(n)], { ($0.text(0), Int($0.int(1)), Int($0.int(2))) }),
        let t = try Anchors.loadFieldText(c, text: text, doc: o.1, field: span.0), span.1 < span.2, span.2 <= t.units.count,
        let anchor = try anchorKey(c, try Anchors.make(t.units, field: span.0, start: span.1, end: span.2, docId: o.1, sha: t.sha))
      else { return nil }
      return .occurrence(expr: expr, anchor: anchor)
    case "expression": return try n.flatMap { try exprKey(c, $0) }.map { .expression(key: $0) }
    case "etymon": return .etymon(key: ref)
    case "cluster": return try n.flatMap { try clusterKey(c, $0) }.map { .cluster(key: $0) }
    default: return nil
    }
  }

  /// The endpoint's `(type, ref)` in this generation, or the reason it cannot be found.
  public static func resolveEndpoint(_ c: Connection, text: any TextStore, _ k: EndpointKey) throws -> Result<(String, String), Unresolved> {
    switch k {
    case .document(let key):
      guard let id = try docId(c, key) else { return .failure(.missing("document \(key.collection):\(key.extId)")) }
      return .success(("document", String(id)))
    case .passage(let anchor):
      switch try resolve(c, text: text, anchor) {
      case .missingDocument(let d): return .failure(.missing("document \(d.collection):\(d.extId)"))
      case .orphaned(let reason): return .failure(.orphaned(reason))
      case .found(let a, _):
        guard let doc = a.docId, let p = try Anchors.passageFor(c, doc: doc, field: a.field, start: a.start, end: a.end) else {
          return .failure(.orphaned("no passage covers the words"))
        }
        return .success(("passage", String(p.id)))
      }
    case .occurrence(let expr, let anchor):
      guard let e = try exprId(c, expr) else { return .failure(.missing("expression '\(expr.norm)'")) }
      switch try resolve(c, text: text, anchor) {
      case .missingDocument(let d): return .failure(.missing("document \(d.collection):\(d.extId)"))
      case .orphaned(let reason): return .failure(.orphaned(reason))
      case .found(let a, _):
        guard let doc = a.docId,
          let o = try c.prepared(ProvenanceSQL.occurrenceAt).bindingFirst([.int(e), .int(doc), .int(Int64(a.start)), .int(Int64(a.end))], {
            $0.int(0)
          })
        else { return .failure(.missing("the occurrence of '\(expr.norm)' (its count is not restored yet)")) }
        return .success(("occurrence", String(o)))
      }
    case .expression(let key):
      guard let id = try exprId(c, key) else { return .failure(.missing("expression '\(key.norm)'")) }
      return .success(("expression", String(id)))
    case .etymon(let key): return .success(("etymon", key))
    case .cluster(let key):
      guard let id = try clusterId(c, key) else { return .failure(.missing("the context groups of run \(key.run.stage)")) }
      return .success(("cluster", String(id)))
    }
  }

  /// Why a key does not resolve in this generation.
  public enum Unresolved: Error, Sendable, Equatable, CustomStringConvertible {
    /// An input the replay waits for (a pack, an import, a run).
    case missing(String)
    /// The words of an anchor are gone: kept as an orphaned interpretation.
    case orphaned(String)
    public var description: String {
      switch self {
      case .missing(let s): "needs \(s), which is not in this atlas yet"
      case .orphaned(let s): s
      }
    }
  }

  // MARK: rows created by journal acts

  static func maxIds(_ s: String?) -> JSONValue? { s.flatMap { try? JSONValue.parse($0) } }

  static func baseMax(_ c: Connection, _ table: String) throws -> Int64 {
    guard let s = try Meta.get(c, "base_max_ids"), let v = try? JSONValue.parse(s) else { return 0 }
    return Int64(v[table]?.integer ?? 0)
  }

  /// The ids of `table` that act `seq` created: (lo, hi]. nil when the act is not applied here or the atlas has no
  /// journal bookkeeping (a reference database).
  public static func createdRange(_ c: Connection, seq: UInt64, table: String) throws -> (lo: Int64, hi: Int64)? {
    guard c.profile == .device,
      let at = try c.prepared(ProvenanceSQL.appliedAt).bindingFirst([.int(Int64(seq))], { maxIds($0.text(0)) }) ?? nil,
      let hi = at[table]?.integer
    else { return nil }
    let before = try c.prepared(ProvenanceSQL.appliedMaxBefore).bindingFirst([.text(table), .int(Int64(seq))]) { $0.intOrNil(0) } ?? nil
    return (max(before ?? 0, try baseMax(c, table)), Int64(hi))
  }

  /// The act that created log row `id` of `table` (the first act after which the table's max id reached it), unless the
  /// row predates the journal (the starter's).
  public static func creatingAct(_ c: Connection, table: String, id: Int64) throws -> (seq: UInt64, op: String)? {
    guard c.profile == .device, id > (try baseMax(c, table)) else { return nil }
    return try c.prepared(ProvenanceSQL.appliedCovering).bindingFirst([.text(table), .int(id)]) { (UInt64($0.int(0)), $0.text(1)) }
  }

  static let annotationActs: Set<String> = ["annotationCreate", "annotationReinterpret", "relationshipReview", "clusterLabel"]

  public static func annotationKey(_ c: Connection, _ id: Int64) throws -> AnnotationKey {
    if let rev1 = try c.prepared(ProvenanceSQL.annotationFirstRevisionId).bindingFirst([.int(id)], { $0.int(0) }),
      let act = try creatingAct(c, table: "annotation_revision", id: rev1), annotationActs.contains(act.op)
    {
      return AnnotationKey(seq: act.seq)
    }
    return AnnotationKey(seq: baseMark + UInt64(id))
  }

  public static func annotationId(_ c: Connection, _ k: AnnotationKey) throws -> Int64? {
    if k.seq >= baseMark { return Int64(k.seq - baseMark) }
    guard let r = try createdRange(c, seq: k.seq, table: "annotation_revision") else { return nil }
    return try c.prepared(ProvenanceSQL.annotationCreatedIn).bindingFirst([.int(r.lo), .int(r.hi)]) { $0.int(0) }
  }

  /// sha256 of the canonical JSON of (rel_type, src, dst, source_dataset, source_locator).
  static func naturalHash(_ c: Connection, _ id: Int64) throws -> (hash: String, origin: String, run: Int64?, src: (String, String), dst: (String, String))? {
    try c.prepared(ProvenanceSQL.relKeyRow).bindingFirst([.int(id)]) { r in
      let nat: JSONValue = [.string(r.text(0)), .string("\(r.text(1)):\(r.text(2))"), .string("\(r.text(3)):\(r.text(4))"),
                            r.textOrNil(5).map(JSONValue.string) ?? .null, r.textOrNil(6).map(JSONValue.string) ?? .null]
      return (IDs.sha256Hex(CanonicalJSON.string(nat)), r.text(7), r.intOrNil(8), (r.text(1), r.text(2)), (r.text(3), r.text(4)))
    }
  }

  public static func relKey(_ c: Connection, text: any TextStore, _ id: Int64) throws -> RelKey {
    if let rev1 = try c.prepared(ProvenanceSQL.relFirstRevision).bindingFirst([.int(id)], { $0.int(0) }),
      let act = try creatingAct(c, table: "relationship_revision", id: rev1), act.op == "relationshipPropose"
    {
      return .human(seq: act.seq)
    }
    guard let nat = try naturalHash(c, id) else { return .documented(hash: "@\(id)") }
    if nat.origin == "algorithm", let run = nat.run, let rk = try runKey(c, run),
      let s = try endpointKey(c, text: text, type: nat.src.0, ref: nat.src.1),
      let d = try endpointKey(c, text: text, type: nat.dst.0, ref: nat.dst.1)
    {
      return .computed(run: rk, src: s, dst: d)
    }
    return .documented(hash: "\(nat.hash)@\(id)")
  }

  public static func relId(_ c: Connection, text: any TextStore, _ k: RelKey) throws -> Int64? {
    switch k {
    case .human(let seq):
      guard let r = try createdRange(c, seq: seq, table: "relationship_revision") else { return nil }
      return try c.prepared(ProvenanceSQL.relCreatedIn).bindingFirst([.int(r.lo), .int(r.hi)]) { $0.int(0) }
    case .documented(let hash):
      guard let at = hash.lastIndex(of: "@"), let id = Int64(hash[hash.index(after: at)...]) else { return nil }
      let want = String(hash[..<at])
      guard let nat = try naturalHash(c, id), want.isEmpty || nat.hash == want else { return nil }
      return id
    case .computed(let run, let src, let dst):
      guard let runId = try runId(c, run), case .success(let s) = try resolveEndpoint(c, text: text, src),
        case .success(let d) = try resolveEndpoint(c, text: text, dst)
      else { return nil }
      return try c.prepared(ProvenanceSQL.relOfRun).bindingFirst([.int(runId), .text(s.0), .text(s.1), .text(d.0), .text(d.1)]) {
        $0.int(0)
      }
    }
  }

  /// A hypothesis group: the act that opened it (the first hypothesisGroupCreate whose target and question are the
  /// group's), else its id.
  public static func groupKey(_ c: Connection, text: any TextStore, _ id: Int64, journal: [JournalEntry]) throws -> HypothesisGroupKey {
    guard let g = try c.prepared(ProvenanceSQL.groupsWithQuestion).bindingFirst([.int(id)], { ($0.text(1), $0.text(2), $0.text(3)) }) else {
      return HypothesisGroupKey(seq: baseMark + UInt64(id))
    }
    for e in journal {
      guard case .hypothesisGroupCreate(let op) = e.op,
        let q = op.request["question"]?.stringValue, JSString.trim(q) == g.2,
        case .success(let t) = try resolveEndpoint(c, text: text, op.target), t.0 == g.0, t.1 == g.1
      else { continue }
      return HypothesisGroupKey(seq: e.seq)
    }
    return HypothesisGroupKey(seq: baseMark + UInt64(id))
  }

  public static func groupId(_ c: Connection, text: any TextStore, _ k: HypothesisGroupKey, journal: [JournalEntry]) throws -> Int64? {
    if k.seq >= baseMark { return Int64(k.seq - baseMark) }
    guard let e = journal.first(where: { $0.seq == k.seq }), case .hypothesisGroupCreate(let op) = e.op,
      let q = op.request["question"]?.stringValue, case .success(let t) = try resolveEndpoint(c, text: text, op.target)
    else { return nil }
    return try c.prepared(ProvenanceSQL.groupByQuestion).bindingFirst([.text(t.0), .text(t.1), .text(JSString.trim(q))]) { $0.int(0) }
  }

  // MARK: annotation targets

  public static func annotationTarget(_ c: Connection, text: any TextStore, type: String, ref: String, anchor: AnchorValue?,
                                      journal: [JournalEntry]) throws -> AnnotationTarget? {
    switch type {
    case "passage", "occurrence":
      guard let anchor, let p = try anchorKey(c, anchor) else { return nil }
      if type == "passage" { return .endpoint(key: .passage(anchor: p)) }
      guard let n = Refs.intId(ref), let o = try c.prepared(ProvenanceSQL.occurrenceRow).bindingFirst([.int(n)], { $0.int(0) }),
        let expr = try exprKey(c, o)
      else { return nil }
      return .endpoint(key: .occurrence(expr: expr, anchor: p))
    case "document", "expression", "cluster":
      return try endpointKey(c, text: text, type: type, ref: ref).map { .endpoint(key: $0) }
    case "relationship":
      return try Refs.intId(ref).map { .relationship(key: try relKey(c, text: text, $0)) }
    case "hypothesis_group":
      return try Refs.intId(ref).map { .hypothesisGroup(key: try groupKey(c, text: text, $0, journal: journal)) }
    case "saved_view":
      return .savedView(slug: ref)
    case "time_window":
      guard let n = Refs.intId(ref), let w = try c.prepared(ProvenanceSQL.timeWindowKey).bindingFirst([.int(n)], { ($0.int(0), $0.text(1)) }),
        let run = try runKey(c, w.0)
      else { return nil }
      return .timeWindow(run: run, label: w.1)
    case "annotation":
      return try Refs.intId(ref).map { .annotation(key: try annotationKey(c, $0)) }
    default:
      return nil
    }
  }
}
