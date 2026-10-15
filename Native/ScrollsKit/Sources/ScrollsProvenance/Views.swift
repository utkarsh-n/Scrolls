// OWNER: N6
// Port of server/provenance/views.mjs (SPEC D17, §7.2, §8.2): immutable saved views.
// A saved view pins the data version, the import cutoff (max committed import_batch), the run ids, and the annotation
// and relationship revision cutoffs; the view_immutable trigger refuses any later UPDATE of them. Re-saving never edits:
// it creates '<slug>~2', '~3' … with parent_slug set. Deleting is soft (the link stops resolving; the row stays). Opening
// a view reports how the data drifted since, and its "as saved" counts (documents ≤ the import cutoff, soft-deleted ones
// still counted, pinned runs) reproduce the counts at save. On the phone the numbers a view is opened with come from
// `ViewCutoffs` (IOS-SPEC §6.4): the saved numbers in the generation of the save, recomputed ones in any other.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// The cutoffs and pins a view is opened with (IOS-SPEC §6.4). In the generation where it was saved these are the
/// `saved_view` numbers; elsewhere `ViewCutoffResolver` recomputes them from the journal.
public struct ViewCutoffs: Sendable, Equatable {
  public var importBatch: Int64
  public var annotationRev: Int64
  public var relationshipRev: Int64
  /// `run_ids_json`, with each run id mapped to this generation's run.
  public var runIds: JSONValue
  /// The saved state with strand, selection and run ids mapped to this generation.
  public var state: JSONValue
  public init(importBatch: Int64, annotationRev: Int64, relationshipRev: Int64, runIds: JSONValue, state: JSONValue) {
    self.importBatch = importBatch
    self.annotationRev = annotationRev
    self.relationshipRev = relationshipRev
    self.runIds = runIds
    self.state = state
  }
}

/// A `saved_view` row, hydrated (`hydrate`).
public struct SavedViewRow: Sendable, Equatable {
  public let id: Int64
  public let slug: String
  public let parentSlug: String?
  public let name: String
  public let description: String?
  public let stateJSON: String
  public let stateHash: String
  public let dataVersion: Int
  public let maxImportBatch: Int64
  public let runIdsJSON: String
  public let annotationRevCutoff: Int64
  public let relationshipRevCutoff: Int64
  public let comparisonsTried: Int
  public let createdBy: String
  public let createdAt: String
  public let deletedAt: String?
  public var state: JSONValue { (try? JSONValue.parse(stateJSON)) ?? [:] }
  public var runIds: JSONValue { (try? JSONValue.parse(runIdsJSON)) ?? [:] }

  /// The numbers stored at save (the reference's, used as they are in the generation of the save).
  public var savedCutoffs: ViewCutoffs {
    ViewCutoffs(importBatch: maxImportBatch, annotationRev: annotationRevCutoff, relationshipRev: relationshipRevCutoff,
                runIds: runIds, state: state)
  }
}

public enum Views {
  /// Run kinds a view state pins besides materialize (§8.2 runs).
  static let pinnedKinds = ["cluster", "quotes", "vectors"]
  static let maxName = 120

  /// Exact copy of §7.2 for a view whose corpus changed.
  public static func driftMessage(_ cutoff: Int64) -> String {
    "Corpus changed since this view was saved. 'As saved' restricts to imports ≤ #\(cutoff) and the pinned runs."
  }

  /// The drift sentence for imports reverted after the save (their documents are only soft-deleted, D17).
  public static func revertedNote(_ batches: [Int64]) -> String {
    let one = batches.count == 1
    let head = one ? "Import #\(batches[0]) was" : "Imports \(batches.map { "#\($0)" }.joined(separator: ", ")) were"
    return "\(head) reverted since; 'As saved' still counts \(one ? "its" : "their") documents."
  }

  static func isSafe(_ v: JSONValue?) -> Int64? {
    guard case .number(let n)? = v, JSNumber.isSafeInteger(n) else { return nil }
    return Int64(n)
  }

  static func runStatus(_ c: Connection, _ id: Int64) throws -> String? {
    try c.prepared(ProvenanceSQL.runRow).bindingFirst([.int(id)]) { $0.text(2) }
  }

  // MARK: pins

  /// `pinnedRuns`: the state's runs (when they succeeded); the materialize run of every member of its expression
  /// strands and, for context-group lanes, the clustering run the query shows — both as the timeline query resolves
  /// them now; the current reuse-index run (quotes) when the state names none; and the boilerplate pass behind its
  /// denominators. A saved view never follows a newer run (§13 rule 17).
  static func pinnedRuns(_ c: Connection, state: JSONValue, warnings: inout [String], scope: CorpusScope? = nil) throws -> JSONObject {
    let runs = state["runs"]?.objectValue ?? JSONObject()
    var out = JSONObject()
    var mat = JSONObject()
    var order: [String] = []
    func pin(_ key: String, _ id: Int64?) throws {
      guard let id, mat[key] == nil else { return }
      if try runStatus(c, id) == "succeeded" {
        mat[key] = .number(Double(id))
        order.append(key)
      } else {
        warnings.append("materialize run \(id) for expression \(key) is not a succeeded run; not pinned")
      }
    }
    var def: ViewDef?
    do { def = try ViewScope.def(c, state: state, scopeOverride: scope) } catch let e as ScrollsError {
      warnings.append("the view's query could not be resolved: \(e.message)")
    }
    for s in def?.strands ?? [] where s.type == "expression" {
      for m in s.members { if let ref = m.ref { try pin(String(ref), m.run) } }
    }
    // a strand the def could not resolve keeps the rule of contract 1.0: its asked or current materialize run
    for s in state["strands"]?.arrayValue ?? [] {
      guard s["type"]?.stringValue == "expression", let idv = s["id"] else { continue }
      let n = Annotations.jsNumber(idv)
      guard JSNumber.isSafeInteger(n) else { continue }
      let key = JSNumber.format(n)
      if mat[key] != nil { continue }
      let asked = isSafe(runs["materialize"]?[key])
      try pin(key, asked ?? (try c.prepared(ProvenanceSQL.readyRun).bindingFirst([.int(Int64(n))]) { $0.int(0) }))
    }
    if !mat.isEmpty { out["materialize"] = .object(mat) }
    for k in pinnedKinds {
      guard let v = runs[k], !v.isNull else { continue }
      let id = isSafe(v)
      if let id, try runStatus(c, id) == "succeeded" {
        out[k] = .number(Double(id))
      } else {
        warnings.append("\(k) run \(Anchors.jsString(v)) is not a succeeded run; not pinned")
      }
    }
    // context-group lanes show one clustering run's groups and labels: pin the one on screen
    if out["cluster"] == nil, state["lanes"]?["facet"]?.stringValue == "cluster", let d = def, d.clusterOK, let run = d.clusterRun {
      out["cluster"] = .number(Double(run))
    }
    // the quotation links in view are those of the current reuse index unless the state names a run
    if out["quotes"] == nil, let q = try c.prepared(ProvenanceSQL.latestRunOfStage).bindingFirst([.text("reuse-index")], { $0.int(0) }) {
      out["quotes"] = .number(Double(q))
    }
    // passage quality (boilerplate) is part of every denominator: pin the pass the counts were made under
    if let bp = try c.prepared(ProvenanceSQL.latestRunOfStage).bindingFirst([.text("boilerplate")], { $0.int(0) }) {
      out["boilerplate"] = .number(Double(bp))
    }
    return out
  }

  // MARK: scope and counts

  /// `viewScope`: the corpora of the view's corpus slug; nil for an unknown slug.
  static func viewScope(_ c: Connection, state: JSONValue, override: CorpusScope?) -> CorpusScope? {
    if let override { return override }
    guard let slug = state["corpus"]?.stringValue else { return nil }
    return try? ViewScope.resolve(c, slug: slug)
  }

  /// `scopeCollections`: collection ids in the view's corpora, after its coll filter ('-x' excludes).
  static func scopeCollections(_ c: Connection, state: JSONValue, scope: CorpusScope?) throws -> [Int64] {
    let rows = try c.prepared(ProvenanceSQL.collectionsOfCorpora).bindingFirstAll([.text(ViewScope.idsJSON(scope?.ids ?? []))]) {
      (id: $0.int(0), slug: $0.text(1))
    }
    let coll = (state["f"]?["coll"]?.arrayValue ?? []).compactMap(\.stringValue)
    let inc = coll.filter { !$0.hasPrefix("-") }
    let exc = coll.filter { $0.hasPrefix("-") }.map { String($0.dropFirst()) }
    return rows.filter { r in
      (inc.isEmpty || inc.contains(r.slug) || inc.contains(String(r.id))) && !exc.contains(r.slug) && !exc.contains(String(r.id))
    }.map(\.id)
  }

  /// `strandMemberIds`: the expression ids a strand stands for (its siblings in every member of a virtual corpus).
  static func strandMemberIds(_ c: Connection, scope: CorpusScope?, id: Int64) throws -> [Int64] {
    guard let scope, scope.virtual, let e = try ViewScope.expression(c, id) else { return [id] }
    return try ViewScope.siblings(c, kind: e.kind, lang: e.lang, norm: e.norm, members: scope.members).compactMap { $0 }
  }

  /// `viewCounts`: raw counts of a view's scope: documents, passages, quality='ok' text tokens, and per expression strand
  /// the materialized matches. With `asSaved`, only documents of imports ≤ the cutoff that existed at save time count
  /// (soft-deleted later still count) and strands use the pinned materialize runs.
  static func counts(_ c: Connection, view v: SavedViewRow, cutoffs: ViewCutoffs, asSaved: Bool, scope override: CorpusScope?) throws -> JSONValue {
    let state = cutoffs.state
    let scope = viewScope(c, state: state, override: override)
    let colls = ViewScope.idsJSON(try scopeCollections(c, state: state, scope: scope))
    let docArgs: [SQLValue] = asSaved ? [.text(colls), .int(cutoffs.importBatch), .text(v.createdAt), .text(v.createdAt)] : [.text(colls)]
    let docs = try c.prepared(asSaved ? ProvenanceSQL.countDocsAsSaved : ProvenanceSQL.countDocs).bindingFirst(docArgs) {
      ($0.int(0), $0.int(1))
    } ?? (0, 0)
    let tokens = try c.prepared(asSaved ? ProvenanceSQL.countTokensAsSaved : ProvenanceSQL.countTokens).bindingFirst(docArgs) {
      $0.int(0)
    } ?? 0
    var strands = JSONObject()
    let pinned = cutoffs.runIds["materialize"]?.objectValue ?? JSONObject()
    for s in state["strands"]?.arrayValue ?? [] {
      guard s["type"]?.stringValue == "expression", let idv = s["id"] else { continue }
      let n = Annotations.jsNumber(idv)
      guard JSNumber.isSafeInteger(n) else { continue }
      let key = JSNumber.format(n)
      var total: Int64 = 0, docsN: Int64 = 0
      var first: Int64?
      var runs = JSONObject()
      for id in try strandMemberIds(c, scope: scope, id: Int64(n)) {
        let current = asSaved ? nil : try c.prepared(ProvenanceSQL.readyRun).bindingFirst([.int(id)]) { $0.int(0) }
        guard let run = current ?? isSafe(pinned[String(id)]) else { continue }
        let r = try c.prepared(asSaved ? ProvenanceSQL.countStrandAsSaved : ProvenanceSQL.countStrand)
          .bindingFirst([.int(id), .int(run)] + docArgs) { ($0.int(0), $0.int(1)) } ?? (0, 0)
        total += r.0
        docsN += r.1
        runs[String(id)] = .number(Double(run))
        if first == nil { first = run }
      }
      guard let first else { continue }
      var entry: JSONObject = ["n": .number(Double(total)), "docs": .number(Double(docsN)), "run": .number(Double(first))]
      if runs.count > 1 { entry["runs"] = .object(runs) }
      strands[key] = .object(entry)
    }
    return ["documents": .number(Double(docs.0)), "passages": .number(Double(docs.1)), "tokens": .number(Double(tokens)),
            "strands": .object(strands)]
  }

  // MARK: rows → JSON

  static func readRow(_ r: Row) -> SavedViewRow {
    SavedViewRow(id: r.int(0), slug: r.text(1), parentSlug: r.textOrNil(2), name: r.text(3), description: r.textOrNil(4),
                 stateJSON: r.text(5), stateHash: r.text(6), dataVersion: Int(r.int(7)), maxImportBatch: r.int(8),
                 runIdsJSON: r.text(9), annotationRevCutoff: r.int(10), relationshipRevCutoff: r.int(11),
                 comparisonsTried: Int(r.int(12)), createdBy: r.text(13), createdAt: r.text(14), deletedAt: r.textOrNil(15))
  }

  /// `viewRow(db, slug)`: the view, or 404 (a soft-deleted view does not resolve unless asked for).
  public static func row(_ c: Connection, slug: String, includeDeleted: Bool = false) throws -> SavedViewRow {
    guard !slug.isEmpty, let v = try c.prepared(ProvenanceSQL.viewBySlug).bindingFirst([.text(slug)], readRow),
      v.deletedAt == nil || includeDeleted
    else { throw ProvenanceError.notFound("No saved view \(slug).") }
    return v
  }

  static func synthetic(_ c: Connection, state: JSONValue) throws -> Bool {
    guard let corpus = state["corpus"]?.stringValue else { return false }
    return try c.prepared(ProvenanceSQL.corpusSynthetic).bindingFirst([.text(corpus)]) { $0.int(0) } == 1
  }

  /// Succeeded runs newer than a pinned one, of the same stage and scope ("A newer analysis exists (run #19)").
  static func newerRuns(_ c: Connection, runIds: JSONValue) throws -> [JSONValue] {
    var out: [JSONValue] = []
    func newerThan(_ pinnedId: Int64, _ label: String) throws {
      guard let p = try c.prepared(ProvenanceSQL.runRow).bindingFirst([.int(pinnedId)], { (id: $0.int(0), stage: $0.text(1), scope: $0.text(3)) })
      else { return }
      if let newer = try c.prepared(ProvenanceSQL.newerRun).bindingFirst([.text(p.stage), .int(p.id), .text(p.scope)], { $0.int(0) }) {
        out.append(["stage": .string(label), "run": .number(Double(newer)), "pinned": .number(Double(p.id))])
      }
    }
    let mat = runIds["materialize"]?.objectValue ?? JSONObject()
    // Object.entries: integer-like keys ascending
    for key in mat.keys.sorted(by: { (Int($0) ?? .max, $0) < (Int($1) ?? .max, $1) }) {
      guard let id = isSafe(mat[key]) else { continue }
      let expr = Annotations.jsNumber(.string(key))
      let current = expr.isFinite ? try c.prepared(ProvenanceSQL.readyRun).bindingFirst([.double(expr)]) { $0.int(0) } : nil
      if let current, current != id {
        out.append(["stage": "materialize", "run": .number(Double(current)), "pinned": .number(Double(id)), "expression": .number(expr)])
      }
    }
    for k in pinnedKinds + ["boilerplate"] { if let id = isSafe(runIds[k]) { try newerThan(id, k) } }
    return out
  }

  static func drift(_ c: Connection, _ v: SavedViewRow, cutoffs: ViewCutoffs) throws -> (current: Int, drift: JSONValue) {
    let current = try Meta.dataVersion(c)
    let importsSince = try c.prepared(ProvenanceSQL.importsSince).bindingFirstAll([.int(cutoffs.importBatch)]) { r -> JSONValue in
      ["batch": .number(Double(r.int(0))), "file": r.textOrNil(1).map(JSONValue.string) ?? .null,
       "collection": r.textOrNil(2).map(JSONValue.string) ?? .null, "committed_at": r.textOrNil(3).map(JSONValue.string) ?? .null]
    }
    let reverted = try c.prepared(ProvenanceSQL.revertedSince).bindingFirstAll([.int(cutoffs.importBatch), .text(v.createdAt)]) {
      r -> (batch: Int64, json: JSONValue) in
      (r.int(0), ["batch": .number(Double(r.int(0))), "file": r.textOrNil(1).map(JSONValue.string) ?? .null,
                  "collection": r.textOrNil(2).map(JSONValue.string) ?? .null,
                  "reverted_at": r.textOrNil(3).map(JSONValue.string) ?? .null])
    }
    let changed = current != v.dataVersion || !importsSince.isEmpty || !reverted.isEmpty
    let annotationsSince = try c.prepared(ProvenanceSQL.annotationRevisionsSince).bindingFirst([.int(cutoffs.annotationRev)]) { $0.int(0) } ?? 0
    let reviewsSince = try c.prepared(ProvenanceSQL.relationshipRevisionsSince).bindingFirst([.int(cutoffs.relationshipRev)]) { $0.int(0) } ?? 0
    var message: JSONValue = .null
    if changed {
      message = .string(driftMessage(cutoffs.importBatch) + (reverted.isEmpty ? "" : " " + revertedNote(reverted.map(\.batch))))
    }
    return (current, [
      "dataChanged": .bool(changed), "importsSince": .array(importsSince), "revertedSince": .array(reverted.map(\.json)),
      "asSavedAvailable": true, "newerRuns": .array(try newerRuns(c, runIds: cutoffs.runIds)),
      "annotationsSince": .number(Double(annotationsSince)), "relationshipRevisionsSince": .number(Double(reviewsSince)),
      "message": message,
    ])
  }

  /// `encode(state)`: the view-state hash fragment of a stored (canonical) state.
  static func hashFragment(_ state: JSONValue) -> String {
    var w: [String] = []
    return ViewState.encode(ViewState.canonicalize(state, warnings: &w))
  }

  /// GET /api/views/:slug (`asSaved` → the state with asSaved: true; the response always carries the cutoffs, pins and
  /// both "as saved" and current counts).
  public static func json(_ c: Connection, _ v: SavedViewRow, cutoffs: ViewCutoffs, asSaved: Bool, scope: CorpusScope? = nil) throws -> JSONValue {
    var state = cutoffs.state
    if asSaved, case .object(var o) = state {
      o["asSaved"] = true
      state = .object(o)
    }
    let (current, drift) = try drift(c, v, cutoffs: cutoffs)
    return [
      "slug": .string(v.slug), "name": .string(v.name), "description": v.description.map(JSONValue.string) ?? .null,
      "parent_slug": v.parentSlug.map(JSONValue.string) ?? .null, "state": state, "state_hash": .string(v.stateHash),
      "hash": .string(hashFragment(cutoffs.state)), "url": .string("/#view=\(v.slug)"), "savedAt": .string(v.createdAt),
      "savedBy": .string(v.createdBy), "dataVersion": .number(Double(v.dataVersion)), "currentDataVersion": .number(Double(current)),
      "runIds": cutoffs.runIds,
      "cutoffs": ["import_batch": .number(Double(cutoffs.importBatch)), "annotation_rev": .number(Double(cutoffs.annotationRev)),
                  "relationship_rev": .number(Double(cutoffs.relationshipRev))],
      "comparisons_tried": .number(Double(v.comparisonsTried)), "asSaved": .bool(asSaved), "drift": drift,
      "counts": ["asSaved": try counts(c, view: v, cutoffs: cutoffs, asSaved: true, scope: scope),
                 "current": try counts(c, view: v, cutoffs: cutoffs, asSaved: false, scope: scope)],
      "synthetic": .bool(try synthetic(c, state: v.state)),
    ]
  }

  // MARK: writes

  static func nextSlug(_ c: Connection, root: String) throws -> String {
    var escaped = ""
    for ch in root { if ch == "\\" || ch == "%" || ch == "_" { escaped.append("\\") }; escaped.append(ch) }
    let rows = try c.prepared(ProvenanceSQL.slugsLike).bindingFirstAll([.text(root), .text(escaped + "~%")]) { $0.text(0) }
    var n = 1
    for slug in rows {
      guard let tilde = slug.lastIndex(of: "~") else { continue }
      let digits = slug[slug.index(after: tilde)...]
      guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }), let k = Int(digits) else { continue }
      if slug == "\(root)~\(digits)" { n = max(n, k) }
    }
    return "\(root)~\(n + 1)"
  }

  /// What a save produced: the response body, and what the journal's portable cutoffs need (the row id and pins).
  public struct Saved: Sendable {
    public let response: JSONValue
    public let viewId: Int64
    public let runIds: JSONObject
    public let state: JSONValue
  }

  /// POST /api/views {name, state, comparisons_tried?, description?, parent_slug?, author?}.
  public static func save(_ w: WriteContext, _ request: JSONValue, scope: CorpusScope? = nil) throws -> Saved {
    guard let body = request.objectValue else { throw ProvenanceError.invalid("Send a JSON object.", field: nil) }
    let name = body["name"]?.stringValue.map(JSString.trim) ?? ""
    if name.isEmpty { throw ProvenanceError.invalid("A saved view needs a name.", field: "name") }
    if name.utf16.count > maxName { throw ProvenanceError.invalid("A view name may have at most \(maxName) characters.", field: "name") }
    guard let stateIn = body["state"], stateIn.objectValue != nil else {
      throw ProvenanceError.invalid("A saved view needs its state.", field: "state")
    }
    var description: String?
    if let d = body["description"]?.stringValue, !JSString.trim(d).isEmpty {
      description = String(decoding: Anchors.jsSlice(Array(JSString.trim(d).utf16), 0, 2000), as: UTF16.self)
    }
    let triedValue = body["comparisons_tried"].nonNull ?? .number(0)
    guard let tried = isSafe(triedValue), tried >= 0 else {
      throw ProvenanceError.invalid("comparisons_tried must be a non-negative integer.", field: "comparisons_tried")
    }
    let actor = Refs.humanActor(try Refs.authorName(body["author"]))
    var warnings: [String] = []
    let canonical = ViewState.canonicalize(stateIn, warnings: &warnings)
    let hash = canonical.stateHash
    let state = canonical.jsonValue

    var slug: String
    var parentSlug: String?
    if let parent = body["parent_slug"].nonNull ?? body["parent"].nonNull {
      guard let p = parent.stringValue,
        try w.c.prepared(ProvenanceSQL.slugExists).bindingFirst([.text(p)], { _ in true }) == true
      else {
        throw ProvenanceError.notFound("No saved view \(Anchors.jsString(parent)) to save from.", field: "parent_slug")
      }
      parentSlug = p
      slug = try nextSlug(w.c, root: JSString.split(p, "~")[0])
    } else {
      let base = "\(IDs.slug(name, max: 40))-\(IDs.shortHash(CanonicalJSON.string([.string(name), .string(hash)]), length: 4))"
      if try w.c.prepared(ProvenanceSQL.slugExists).bindingFirst([.text(base)], { _ in true }) == true {
        parentSlug = base
        slug = try nextSlug(w.c, root: base)
      } else {
        slug = base
      }
    }
    let runIds = try pinnedRuns(w.c, state: state, warnings: &warnings, scope: scope)
    let maxBatch = try w.c.prepared(ProvenanceSQL.maxCommittedBatch).first { $0.int(0) } ?? 0
    let annCut = try w.c.prepared(ProvenanceSQL.maxAnnotationRevision).first { $0.int(0) } ?? 0
    let relCut = try w.c.prepared(ProvenanceSQL.maxRelationshipRevision).first { $0.int(0) } ?? 0
    let dv = try Meta.dataVersion(w.c)
    let id = try w.ids.next("saved_view", w.scope)
    let ins = try w.c.prepared(ProvenanceSQL.insertView)
    try ins.bind(.int(id), .text(slug), .string(parentSlug), .text(name), .string(description), .text(CanonicalJSON.string(state)),
                 .int(Int64(ViewState.version)), .text(hash), .int(Int64(dv)), .int(maxBatch),
                 .text(CanonicalJSON.string(.object(runIds))), .int(annCut), .int(relCut), .int(tried), .text(actor), .text(w.at))
    try ins.run()
    let v = try row(w.c, slug: slug)
    let response: JSONValue = [
      "slug": .string(slug), "url": .string("/#view=\(slug)"), "dataVersion": .number(Double(dv)), "runIds": .object(runIds),
      "hash": .string(ViewState.encode(canonical)), "parent_slug": parentSlug.map(JSONValue.string) ?? .null,
      "savedAt": .string(w.at), "state_hash": .string(hash),
      "cutoffs": ["import_batch": .number(Double(maxBatch)), "annotation_rev": .number(Double(annCut)),
                  "relationship_rev": .number(Double(relCut))],
      "counts": try counts(w.c, view: v, cutoffs: v.savedCutoffs, asSaved: true, scope: scope),
      "warnings": .array(warnings.map(JSONValue.string)), "synthetic": .bool(try synthetic(w.c, state: state)),
    ]
    return Saved(response: response, viewId: id, runIds: runIds, state: state)
  }

  /// GET /api/views?q=&limit=&cursor=: newest first; soft-deleted views are not listed.
  public static func list(_ c: Connection, _ q: ViewsRequest) throws -> JSONValue {
    let limit = try ProvenancePaging.limitFor(q.limit, max: 200, default: 50)
    let before = Int64(try ProvenancePaging.cursor(q.cursor)?["before"]?.integer ?? 9_007_199_254_740_991)
    var like: String?
    if let text = q.q, !JSString.trim(text).isEmpty { like = "%\(JSString.toLowerCase(JSString.trim(text)))%" }
    let rows = try c.prepared(ProvenanceSQL.listViews).bindingFirstAll([.int(before), .string(like), .string(like), .string(like),
                                                                         .int(Int64(limit + 1))]) { r in
      (id: r.int(0), slug: r.text(1), name: r.text(2), description: r.textOrNil(3), parent: r.textOrNil(4), createdAt: r.text(5),
       dataVersion: r.int(6), state: r.text(7), synthetic: r.intOrNil(8))
    }
    let page = rows.prefix(limit)
    let items: [JSONValue] = page.map { v in
      [
        "slug": .string(v.slug), "name": .string(v.name), "description": v.description.map(JSONValue.string) ?? .null,
        "savedAt": .string(v.createdAt), "dataVersion": .number(Double(v.dataVersion)),
        "parent_slug": v.parent.map(JSONValue.string) ?? .null,
        "corpus": (try? JSONValue.parse(v.state))?["corpus"].nonNull ?? .null, "synthetic": .bool(v.synthetic == 1),
      ]
    }
    let cursor: JSONValue = rows.count > limit ? .string(ProvenancePaging.encodeCursor(["before": .number(Double(page.last!.id))])) : .null
    return ["items": .array(items), "cursor": cursor]
  }

  /// DELETE /api/views/:slug: soft delete (deleted_at); the row and its pins stay.
  public static func delete(_ w: WriteContext, slug: String) throws {
    let v = try row(w.c, slug: slug)
    let up = try w.c.prepared(ProvenanceSQL.softDeleteView)
    try up.bind(.text(w.at), .int(v.id))
    try up.run()
  }
}
