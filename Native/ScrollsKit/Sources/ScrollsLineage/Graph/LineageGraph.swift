// OWNER: N5
// Port of server/lineage/graph.mjs (SPEC §2.C, §7.2): the bounded lineage graph, the "chain of custody" view.
//
// Nodes are the items relationships connect (passages, documents, expressions, etymons, clusters, occurrences); rows
// are generations = hops from the root, never meaning. Opens at depth 2 both ways with ≤ 60 nodes; the hard cap is
// 150 nodes, beyond which the response says how many were left out ("Show as list"). Edges carry their evidence status
// (pattern), review status (overlay), type and family; rejected links and the similarity pairs kindred/counterpart are
// hidden unless asked for; rows of an analysis run are visible only when that run succeeded (or a saved view pins it).
// Passages whose wording is shared by > 25 documents get one "widely shared text (n documents)" node instead of n²
// quotation edges. The result is the reference's JSON exactly (G3 `g3.lineage`); LiveAtlas decodes it into the
// contract type.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// One read of the lineage area: a reader connection, the text store and the atlas path (for the commonplace records),
/// with a per-request cache of decoded texts.
public final class LineageReader {
  let c: Connection
  let text: any TextStore
  let atlasPath: String
  private var bodies: [Int64: [UInt16]] = [:]

  public init(_ c: Connection, text: any TextStore, atlasPath: String) {
    self.c = c
    self.text = text
    self.atlasPath = atlasPath
  }

  /// The body text of a document (`document_text.original`, through the text store), cached for this request.
  func body(_ doc: Int64) throws -> [UInt16] {
    if let b = bodies[doc] { return b }
    let b = Array(try text.fullText(DocumentID(rawValue: doc), on: c).utf16)
    if bodies.count > 64 { bodies.removeAll(keepingCapacity: true) }
    bodies[doc] = b
    return b
  }

  /// A field's text: the body through the text store, other fields from `document_field`; nil when missing.
  func fieldText(_ doc: Int64, _ field: String) throws -> [UInt16]? {
    if field == "body" {
      do { return try body(doc) } catch is TextStoreError { return nil }
    }
    return try c.prepared(LineageSQL.fieldValue).bindingFirst([.int(doc), .text(field)]) { Array($0.text(0).utf16) }
  }
}

/// The lineage graph and the expansion of a widely shared text.
public enum LineageGraph {
  public static let defaultNodes = 60
  public static let hardCap = 150
  public static let maxDepth = 6
  public static let layout = "x = the Scroll time scale; rows = hops from the root, never meaning"

  /// `nodeJson(db, ref)`: document facts for passages, documents and occurrences, a label for the rest; nil when the
  /// reference resolves to nothing.
  static func node(_ r: LineageReader, _ ref: String) throws -> JSONObject? {
    let (type, id) = LineageJS.splitRef(ref)
    guard let res = try LineageRefs.resolve(r.c, type: type, id: id) else { return nil }
    var node: JSONObject = ["id": .string(ref), "type": .string(type), "label": .string(res.title ?? ref),
                            "synthetic": .bool(res.synthetic == 1)]
    if let docId = res.docId {
      try r.c.prepared(LineageSQL.nodeDocument).bindingFirst([.int(docId)]) { d -> Void in
        node["doc"] = .number(Double(d.int(0)))
        node["title"] = d.textOrNil(1).map(JSONValue.string) ?? .null
        node["author"] = d.textOrNil(7).map(JSONValue.string) ?? .null
        node["kind"] = d.textOrNil(2).map(JSONValue.string) ?? .null
        node["y"] = d.intOrNil(3).map { .number(Double($0)) } ?? .null
        node["label"] = .string(d.text(5))
        node["precision"] = .string(d.text(4))
        node["undated"] = .bool(d.text(6) != "dated")
      }
      if let p = res.passage {
        // substr(original | value, start_off + 1, 160): SQLite counts code points
        if let units = try r.fieldText(docId, p.field) {
          node["snippet"] = .string(LineageJS.collapseWhitespace(LineageJS.substrCodePoints(units, start: p.startOff, count: 160)))
        } else {
          node["snippet"] = .null
        }
      }
    } else if type == "etymon" {
      let lang = JSString.split(id, ":").first ?? id
      node["label"] = .string("\(res.title ?? "null") (\(lang))")
      node["note"] = "period of the language, not a date"
    }
    return node
  }

  /// `edgesOf(db, f, ref, dir)`: links leaving the node (unless 'in') then links arriving (unless 'out'), as of the
  /// filters' cutoff.
  static func edgesOf(_ r: LineageReader, _ f: EdgeFilters, _ ref: String, _ dir: String) throws -> [EdgeRow] {
    let (type, id) = LineageJS.splitRef(ref)
    var out: [EdgeRow] = []
    if dir != "in" { out += try Edges.rows(r.c, LineageSQL.edgesFrom, .text(type), .text(id), f) }
    if dir != "out" { out += try Edges.rows(r.c, LineageSQL.edgesTo, .text(type), .text(id), f) }
    return try Edges.asOf(r.c, f, out)
  }

  /// `commonplaceLineage(db, root, args)`: the widely shared text node and the passages recorded as made mostly of
  /// it, ≤ max_nodes − 1 of them, each linked to the node (never pairwise); truncation is stated.
  static func commonplace(_ r: LineageReader, root: String, args: QueryArgs) throws -> JSONValue {
    let key = String(String.UnicodeScalarView(root.unicodeScalars.dropFirst("shared:".count)))
    guard key.utf16.count == 8, key.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }) else {
      throw ScrollsError.lineageInvalid("A widely shared text is shared:<8 hex digits>.", field: "root")
    }
    let cp = try Commonplaces.node(key, atlasPath: r.atlasPath)
    let cap = Swift.min(hardCap, Swift.max(2, LineageJS.parseIntOr(args["max_nodes"], defaultNodes)))
    var nodes: [JSONValue] = [["id": .string(cp.id), "type": "commonplace", "label": .string(cp.label),
                               "documents": .number(Double(cp.documents)), "generation": 0, "direction": "root",
                               "synthetic": false, "expandable": 0]]
    var links: [JSONValue] = []
    var missing = 0
    for pid in cp.passages {
      if nodes.count >= cap { break }
      guard var n = try node(r, "passage:\(pid)") else {
        missing += 1
        continue
      }
      n["generation"] = 1
      n["direction"] = "shares"
      n["expandable"] = 0
      nodes.append(.object(n))
      links.append(["from": n["id"] ?? .null, "to": .string(cp.id), "kind": "commonplace"])
    }
    let left = cp.passages.count - missing - links.count
    let unrecorded = Swift.max(0, cp.documents - cp.passages.count)
    let truncated: JSONValue = left > 0
      ? ["nodes": .number(Double(left)),
         "reason": .string("showing \(links.count) of \(links.count + left) recorded passages — raise max_nodes")]
      : ["nodes": 0, "reason": .null]
    let more = unrecorded > 0 ? " The pass records up to 50 passages per text; \(unrecorded) more documents hold it." : ""
    return ["root": .string(root), "nodes": .array(nodes), "edges": [], "groups": [], "links": .array(links),
            "truncated": truncated, "note": .string("Text shared by \(cp.documents) documents is drawn as one node, not as pairs.\(more)"),
            "filters": ["max_nodes": .number(Double(cap))], "layout": .string(layout)]
  }

  /// `lineageQuery(db, args)`: GET /api/lineage?root=&depth=&dir=both|in|out&max_nodes=&types=&status=&rejected=&kindred=
  /// &runs=&rel_rev_cutoff=. `in` follows links whose dst is the node (later items that depend on it); `out` follows
  /// links whose src is the node (its sources). A passage root also shows the links of its document.
  public static func query(_ r: LineageReader, _ args: QueryArgs) throws -> JSONValue {
    let root = args["root"] ?? ""
    guard LineageJS.isRef(root) else {
      throw ScrollsError.lineageInvalid("root must be a reference like 'passage:77'.", field: "root")
    }
    if JSString.hasPrefix(root, "shared:") { return try commonplace(r, root: root, args: args) }
    guard let rootNode = try node(r, root) else { throw ScrollsError.lineageNotFound("No root \(root).") }
    let depth = Swift.min(maxDepth, Swift.max(1, LineageJS.parseIntOr(args["depth"], 2)))
    let dir = ["both", "in", "out"].contains(args["dir"] ?? "") ? args["dir"]! : "both"
    let cap = Swift.min(hardCap, Swift.max(1, LineageJS.parseIntOr(args["max_nodes"], defaultNodes)))
    let f = try EdgeFilters(args)

    // insertion-ordered maps, as the reference's Map
    var nodeOrder: [String] = [root]
    var nodes: [String: JSONObject] = [:]
    var rn = rootNode
    rn["generation"] = 0
    rn["direction"] = "root"
    nodes[root] = rn
    var edgeOrder: [Int64] = []
    var edges: [Int64: JSONObject] = [:]
    var frontier = [root]
    if rootNode["type"] == "passage", let doc = rootNode["doc"]?.safeInteger {
      let docRef = "document:\(doc)"
      if try !edgesOf(r, f, docRef, dir).isEmpty, var dn = try node(r, docRef) {
        dn["generation"] = 0
        dn["direction"] = "root"
        dn["root_document"] = true
        if nodes[docRef] == nil { nodeOrder.append(docRef) }
        nodes[docRef] = dn
        frontier.append(docRef)
      }
    }
    var hidden = Set<String>()
    var pending: [String: Int] = [:]
    var gen = 1
    while gen <= depth && !frontier.isEmpty {
      var next: [String] = []
      for ref in frontier {
        for e in try edgesOf(r, f, ref, dir) {
          let other = e.src == ref ? e.dst : e.src
          if nodes[other] == nil {
            if nodes.count >= cap {
              hidden.insert(other)
              pending[ref, default: 0] += 1
              continue
            }
            guard var n = try node(r, other) else { continue }
            n["generation"] = .number(Double(gen))
            n["direction"] = .string(e.dst == other ? "earlier" : "later")
            nodeOrder.append(other)
            nodes[other] = n
            next.append(other)
          }
          if edges[e.id] == nil { edgeOrder.append(e.id) }
          edges[e.id] = Edges.json(e)
        }
      }
      frontier = next
      gen += 1
    }
    // how many visible links each outermost node still has (the ＋ to expand one hop)
    for ref in frontier {
      let extra = try edgesOf(r, f, ref, dir).filter { edges[$0.id] == nil }.count
      if extra > 0 { pending[ref, default: 0] += extra }
    }
    for ref in nodeOrder { nodes[ref]?["expandable"] = .number(Double(pending[ref] ?? 0)) }

    var groupOrder: [Int64] = []
    var groups: [Int64: JSONValue] = [:]
    for id in edgeOrder {
      guard let g = edges[id]?["hypothesis_group"]?.safeInteger.map(Int64.init), groups[g] == nil else { continue }
      guard let (gid, question) = try r.c.prepared(LineageSQL.groupRow).bindingFirst([.int(g)], { ($0.int(0), $0.text(1)) })
      else { continue }
      let members = try Edges.asOf(r.c, f, try Edges.rows(r.c, LineageSQL.groupMembers, .int(gid), .null, f))
      groupOrder.append(g)
      groups[g] = ["id": .number(Double(gid)), "question": .string(question),
                   "edges": .array(members.map { .number(Double($0.id)) }), "text": .string("⚖ \(members.count) competing")]
    }

    var links: [JSONValue] = []
    let passages = nodeOrder.compactMap { ref -> Int64? in
      guard nodes[ref]?["type"] == "passage" else { return nil }
      return Int64(String(String.UnicodeScalarView(ref.unicodeScalars.dropFirst(8))))
    }
    let cps = Commonplaces.groups(of: passages, atlasPath: r.atlasPath)
    var seenPassages = Set<Int64>()
    for pid in passages where seenPassages.insert(pid).inserted {
      guard let cp = cps[pid] else { continue }
      let id = "shared:\(cp.key)"
      if nodes[id] == nil {
        nodeOrder.append(id)
        nodes[id] = ["id": .string(id), "type": "commonplace", "label": .string("widely shared text (\(cp.docs) documents)"),
                     "documents": .number(Double(cp.docs)), "synthetic": false]
      }
      links.append(["from": .string("passage:\(pid)"), "to": .string(id), "kind": "commonplace"])
    }

    let truncated: JSONValue = hidden.isEmpty
      ? ["nodes": 0, "reason": .null]
      : ["nodes": .number(Double(hidden.count)),
         "reason": .string(cap >= hardCap ? "hard cap \(hardCap) nodes — Show as list" : "showing \(cap) nodes — expand or raise max_nodes")]
    return [
      "root": .string(root),
      "nodes": .array(nodeOrder.compactMap { nodes[$0].map(JSONValue.object) }),
      "edges": .array(edgeOrder.compactMap { edges[$0].map(JSONValue.object) }),
      "groups": .array(groupOrder.compactMap { groups[$0] }),
      "links": .array(links),
      "truncated": truncated,
      "filters": ["depth": .number(Double(depth)), "dir": .string(dir), "max_nodes": .number(Double(cap)), "types": f.typesJSON,
                  "status": f.statusJSON, "rejected": .bool(f.rejected), "kindred": .bool(f.kindred),
                  "rel_rev_cutoff": f.relRevCutoff.map { .number(Double($0)) } ?? .null],
      "layout": .string(layout),
    ]
  }
}
