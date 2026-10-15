// OWNER: N2
// Tour in process (server/routes/tour.mjs): the demo tour of tour.json (the engine's demo resource, byte-equal with
// data/demo/tour.json) with its ids resolved (expressions, passages, occurrences, relationships) into reproducible
// view-state hashes, and its {placeholders} filled with numbers computed from the atlas at request time (SPEC §9.7).
// Nothing numeric is written in tour.json. A strand whose expression is not tracked yet comes back in `track` (what
// the app sends to trackExpression), with the reason in `pending`; nothing is invented.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsSources
import ScrollsStore
import Synchronization

/// The statements of the tour.
public enum TourSQL: SQLCatalog {
  static let docByExt = SQL("tour.docByExt", """
    SELECT d.id, d.date_label FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE c.slug = ? AND d.ext_id = ? AND d.deleted_at IS NULL
    """)
  static let passageAt = SQL("tour.passageAt", """
    SELECT id FROM passage WHERE document_id = ? AND field = 'body' AND start_off <= ? AND end_off >= ?
    ORDER BY start_off DESC LIMIT 1
    """)
  static let expressionID = SQL("tour.expressionID", """
    SELECT e.id FROM expression e LEFT JOIN corpus k ON k.id = e.corpus_id
    WHERE e.norm = ? AND (k.slug = ? OR (e.corpus_id IS NULL AND ? <> 'demo')) ORDER BY (k.slug = ?) DESC, e.id LIMIT 1
    """)
  static let relationship = SQL("tour.relationship", """
    SELECT id FROM relationship WHERE rel_type = ? AND src_type = 'document' AND src_ref = ? AND dst_type = 'document'
      AND dst_ref = ? ORDER BY id LIMIT 1
    """)
  static let occurrence = SQL("tour.occurrence", """
    SELECT o.id FROM occurrence o JOIN expression_state st ON st.expression_id = o.expression_id AND st.run_id = o.run_id
    WHERE o.expression_id = ? AND o.passage_id = ? ORDER BY o.start_off LIMIT 1
    """)
  static let communityDecadeTokens = SQL("tour.communityTokens", """
    SELECT COALESCE(SUM(t.tokens), 0) FROM doc_tokens t JOIN document d ON d.id = t.document_id
      JOIN collection c ON c.id = d.collection_id
    WHERE c.slug = ? AND d.community = ? AND d.chrono_status = 'dated' AND d.y_lo >= ? AND d.y_hi <= ? AND t.field_class = 'text'
    """, scan: .scanOK(reason: "the demo collection's documents, once per data version"))
  static let sliceTokens = SQL("tour.sliceTokens", """
    SELECT COALESCE(SUM(t.tokens), 0) FROM doc_tokens t JOIN document d ON d.id = t.document_id
      JOIN collection c ON c.id = d.collection_id
    WHERE c.slug = ? AND d.chrono_status = 'dated' AND d.y_lo >= ? AND d.y_hi <= ? AND t.field_class = 'text'
    """, scan: .scanOK(reason: "the demo collection's documents, once per data version"))
  static let referenced = SQL("tour.referenced", """
    SELECT raw FROM date_assertion WHERE subject_type = 'document' AND subject_id = ? AND role = 'referenced'
    """, scan: .scanOK(reason: "one document's assertions"))
  static let reuseRun = SQL("tour.reuseRun", """
    SELECT id FROM analysis_run WHERE stage = 'reuse-index' AND status = 'succeeded' ORDER BY id DESC LIMIT 1
    """, scan: .scanOK(reason: "the run log, newest first"))
  static let collectionDocs = SQL("tour.collectionDocs", """
    SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? ORDER BY d.id
    """)
  public static let all: [SQL] = [docByExt, passageAt, expressionID, relationship, occurrence, communityDecadeTokens,
                                  sliceTokens, referenced, reuseRun, collectionDocs]
}

/// The demo generator's counting patterns (data/demo/generator.mjs `findOccurrences`).
enum DemoPatterns {
  enum Part { case word(String), oneOf(Set<String>), prefix(String) }
  static let patterns: [String: [Part]] = [
    "carry the zero": [.oneOf(["carry", "carries", "carried", "carrying"]), .word("the"), .word("zero")],
    "flux up": [.oneOf(["flux", "fluxes", "fluxed", "fluxing"]), .word("up")],
    "ghost in the margin": [.oneOf(["ghost", "ghosts"]), .word("in"), .word("the"), .word("margin")],
    "◉": [.word("◉")],
    "શૂન્ય ઉપાડ": [.word("શૂન્ય"), .prefix("ઉપાડ")],
    "शून्य को साथ": [.word("शून्य"), .word("को"), .word("साथ")],
  ]

  /// `findOccurrences(text, expr)`: [start, end) UTF-16 spans of the original.
  static func find(_ text: String, _ expr: String) -> [(start: Int, end: Int)] {
    guard let pat = patterns[expr] else { return [] }
    let t = Tokenizer.tokens(text)
    var out: [(start: Int, end: Int)] = []
    var i = 0
    while i + pat.count <= t.tokens.count {
      var ok = true
      for (j, p) in pat.enumerated() where ok {
        let tok = t.tokens[i + j]
        switch p {
        case .word(let w): ok = JSString.equal(tok, w)
        case .oneOf(let s): ok = s.contains(tok)
        case .prefix(let p): ok = JSString.hasPrefix(tok, p)
        }
      }
      if ok { out.append((Int(t.starts[i]), Int(t.ends[i + pat.count - 1]))) }
      i += 1
    }
    return out
  }
}

enum TourMemo {
  static let cache = Mutex<[String: (version: Int, body: TourResponse)]>([:])
}

extension LiveAtlas {
  @concurrent
  public func tour() async throws -> TourResponse {
    let path = location.atlasPath, text = self.text
    let tour = try CipherJSON.parse(try DemoPack.resource("tour.json"), what: "tour.json")
    let relationships = try DemoPack.resource("relationships.jsonl")
    return try await reads.read(.interactive, deadline: .seconds(10)) { c in
      try LiveAtlas.tourQuery(c, text: text, path: path, tour: tour, relationships: relationships)
    }
  }

  static let demoCollection = DemoAdapter.collection

  static func docByExt(_ c: Connection, _ ext: String) throws -> (id: Int64, label: String)? {
    try c.prepared(TourSQL.docByExt).bindingFirst([.text(demoCollection), .text(ext)]) { ($0.int(0), $0.text(1)) }
  }

  /// The passage holding a quote (or the first match of a demo expression) in an anchor document.
  static func passageFor(_ c: Connection, text: any TextStore, anchor: String, quote: String? = nil, expr: String? = nil) throws
    -> (doc: Int64, passage: Int64)?
  {
    guard let doc = try docByExt(c, "demo:\(anchor)") else { return nil }
    let original = (try? text.fullText(DocumentID(rawValue: doc.id), on: c)) ?? ""
    var start = -1, end = -1
    if let quote {
      start = JSString.indexOf(original, quote)
      end = start + quote.utf16.count
    } else if let expr, let o = DemoPatterns.find(original, expr).first {
      (start, end) = (o.start, o.end)
    }
    guard start >= 0 else { return nil }
    guard let p = try c.prepared(TourSQL.passageAt).bindingFirst([.int(doc.id), .int(Int64(start)), .int(Int64(end))], { $0.int(0) })
    else { return nil }
    return (doc.id, p)
  }

  /// A tracked expression of a corpus by its surface (an expression tracked for any corpus counts for a real one).
  static func expressionID(_ c: Connection, _ surface: String, corpus: String = "demo") throws -> Int64? {
    let norm = Tokenizer.normString(surface)
    return try c.prepared(TourSQL.expressionID).bindingFirst([.text(norm), .text(corpus), .text(corpus), .text(corpus)]) { $0.int(0) }
  }

  static func relationshipFor(_ c: Connection, key: String, relationships: Data) throws -> Int64? {
    for l in CipherFormat.lines(relationships) {
      let line = CipherFormat.text(relationships, l.byteStart, l.byteEnd)
      guard let spec = try? JSONValue.parse(line), spec["key"]?.stringValue == key else { continue }
      guard let srcExt = spec["src"]?["ext_id"]?.stringValue, let dstExt = spec["dst"]?["ext_id"]?.stringValue,
            let s = try docByExt(c, srcExt), let d = try docByExt(c, dstExt) else { return nil }
      return try c.prepared(TourSQL.relationship).bindingFirst(
        [.text(spec["rel_type"]?.stringValue ?? ""), .text(String(s.id)), .text(String(d.id))]) { $0.int(0) }
    }
    return nil
  }

  /// Longest run of identical folded tokens shared by two documents (a fact about the texts).
  static func longestSharedRun(_ c: Connection, text: any TextStore, _ a: String, _ b: String) throws -> Int {
    func tokens(_ ext: String) throws -> [String] {
      guard let d = try docByExt(c, ext) else { return [] }
      return Tokenizer.tokens((try? text.fullText(DocumentID(rawValue: d.id), on: c)) ?? "").tokens
    }
    let x = try tokens(a), y = try tokens(b)
    guard !y.isEmpty else { return 0 }
    var best = 0
    var prev = [Int](repeating: 0, count: y.count + 1), cur = prev
    for i in stride(from: 1, through: x.count, by: 1) {
      for j in 1...y.count {
        // the reference counts in a Uint16Array, so a run wraps at 65,536 (never reached by the demo's texts)
        cur[j] = JSString.equal(x[i - 1], y[j - 1]) ? (prev[j - 1] + 1) & 0xFFFF : 0
        if cur[j] > best { best = cur[j] }
      }
      prev = cur
    }
    return best
  }

  /// Numbers the tour text quotes, computed from the loaded demo.
  static func placeholders(_ c: Connection, text: any TextStore) throws -> [String: String] {
    var out: [String: String] = [:]
    let coll = demoCollection
    out["hiphop_1980s_tokens"] = Format.tokens(Int(try c.prepared(TourSQL.communityDecadeTokens)
      .bindingFirst([.text(coll), .text("hiphop"), .int(1980), .int(1989)]) { $0.int(0) } ?? 0))
    let a15 = try docByExt(c, "demo:A15")
    out["a15_date"] = a15?.label ?? "the song's date"
    out["a15_referenced"] = try a15.flatMap { try c.prepared(TourSQL.referenced).bindingFirst([.int($0.id)]) { $0.textOrNil(0) } ?? nil } ?? "1911"
    out["a11_a4_run"] = String(try longestSharedRun(c, text: text, "demo:A11", "demo:A4"))
    let reuse = try c.prepared(TourSQL.reuseRun).first { $0.int(0) }
    out["reuse_run"] = reuse.map { "run #\($0)" } ?? "the reuse-index run, once it has run"
    func slice(_ lo: Int64, _ hi: Int64) throws -> String {
      Format.tokens(Int(try c.prepared(TourSQL.sliceTokens).bindingFirst([.text(coll), .int(lo), .int(hi)]) { $0.int(0) } ?? 0))
    }
    out["slice_a_tokens"] = try slice(1955, 1985)
    out["slice_b_tokens"] = try slice(1994, 2026)
    var kiln = 0
    for id in try c.prepared(TourSQL.collectionDocs).bindingAll([.text(coll)], { $0.int(0) }) {
      guard let t = try? text.fullText(DocumentID(rawValue: id), on: c), JSString.indexOf(t, "◉") >= 0 else { continue }
      kiln += DemoPatterns.find(t, "◉").count
    }
    out["kiln_total"] = String(kiln)
    return out
  }

  /// A tour step's state spec → the view-state hash, the ids it resolved, what it still waits for, what to track.
  static func resolveState(_ c: Connection, text: any TextStore, spec: JSONValue, relationships: Data) throws
    -> (hash: String, refs: JSONObject, missing: [String], track: [TrackExpressionRequest])
  {
    let corpus = spec["corpus"]?.stringValue ?? "demo"
    var s = ViewState.defaultState(corpus)
    var refs = JSONObject(), missing: [String] = [], track: [TrackExpressionRequest] = []
    let glyphs = ["circle", "square", "triangle", "diamond"]
    for surface in (spec["strands"]?.arrayValue ?? []).compactMap(\.stringValue) {
      if let id = try expressionID(c, surface, corpus: corpus) {
        s.strands.append(ViewState.Strand(type: "expression", id: .number(Int(id)), variants: .default, glyph: glyphs[min(3, s.strands.count)]))
      } else {
        missing.append("expression '\(surface)' is not tracked yet")
        var t = TrackExpressionRequest(surface: surface, kind: surface.unicodeScalars.contains { JSText.isSpace(UInt16(truncatingIfNeeded: $0.value)) && $0.value < 0x10000 } ? "phrase" : "word",
                                       corpus: corpus)
        if let lang = spec["lang"]?.stringValue { t.lang = lang } else { t.$lang = .null }
        track.append(t)
      }
    }
    if let lanes = spec["lanes"]?.stringValue { s.lanes.facet = lanes }
    for (k, v) in spec["evidence"]?.objectValue ?? [:] { if let n = v.safeInteger { s.evidence[k] = n } }
    if let y = spec["vantage"]?.safeInteger { s.vantage = ViewState.Vantage(day: DayMath.dayFromYMD(y, 12, 31), strict: true) }
    if let p = spec["panels"]?.objectValue {
      if let v = p["inspector"] { s.panels.inspector = v.stringValue }
      if let v = p["right"] { s.panels.right = v.stringValue }
    }
    if let cmp = spec["compare"], let a = cmp["a"]?.arrayValue?.compactMap(\.safeInteger), let b = cmp["b"]?.arrayValue?.compactMap(\.safeInteger) {
      s.compare = ViewState.Compare(a: ViewState.Slice(years: a, f: ""), b: ViewState.Slice(years: b, f: ""))
    }
    if let sel = spec["selection"] {
      switch sel["type"]?.stringValue {
      case "occurrence":
        let anchor = sel["anchor"]?.stringValue ?? "", expr = sel["expr"]?.stringValue ?? ""
        let p = try passageFor(c, text: text, anchor: anchor, expr: expr)
        let exprID = try expressionID(c, expr)
        let occ = try p.flatMap { p in try exprID.flatMap { e in try c.prepared(TourSQL.occurrence).bindingFirst([.int(e), .int(p.passage)]) { $0.int(0) } } }
        if let occ {
          s.selection = ViewState.Selection(type: "occurrence", id: .number(Int(occ)))
          refs["occurrence"] = .number(Double(occ))
        } else if let fb = sel["fallback"] {
          if let f = try passageFor(c, text: text, anchor: fb["anchor"]?.stringValue ?? "", quote: fb["quote"]?.stringValue) {
            s.selection = ViewState.Selection(type: "passage", id: .number(Int(f.passage)))
            refs["passage"] = .number(Double(f.passage))
          }
          missing.append("occurrence not materialized yet; the passage is selected instead")
        }
      case "passage":
        let anchor = sel["anchor"]?.stringValue ?? ""
        if let p = try passageFor(c, text: text, anchor: anchor, quote: sel["quote"]?.stringValue) {
          s.selection = ViewState.Selection(type: "passage", id: .number(Int(p.passage)))
          refs["passage"] = .number(Double(p.passage))
        } else {
          missing.append("passage of \(anchor) not found")
        }
      case "relationship":
        let key = sel["key"]?.stringValue ?? ""
        if let id = try relationshipFor(c, key: key, relationships: relationships) {
          s.selection = ViewState.Selection(type: "relationship", id: .number(Int(id)))
          refs["relationship"] = .number(Double(id))
        } else {
          missing.append("relationship \(key) not found")
        }
      default: break
      }
    }
    if let lin = spec["lineage"] {
      let anchor = lin["anchor"]?.stringValue ?? ""
      if let p = try passageFor(c, text: text, anchor: anchor, quote: lin["quote"]?.stringValue) {
        s.lineage.root = "passage:\(p.passage)"
        refs["lineage_root"] = .string("passage:\(p.passage)")
      } else {
        missing.append("lineage root \(anchor) not found")
      }
    }
    return (ViewState.encode(s), refs, missing, track)
  }

  private static let placeholder = JSRegex(js: #"\{([a-z0-9_]+)\}"#)

  /// `tourQuery(db)`.
  static func tourQuery(_ c: Connection, text: any TextStore, path: String, tour: JSONValue, relationships: Data) throws -> TourResponse {
    let version = try Meta.dataVersion(c)
    if let hit = TourMemo.cache.withLock({ $0[path] }), hit.version == version { return hit.body }
    guard try docByExt(c, "demo:A15") != nil else {
      throw ScrollsError(code: ErrorCode(rawValue: "E_DEMO_NOT_LOADED"), message: "The tour needs the demo corpus, which is still loading.",
                         hint: "Wait a few seconds and retry.", status: 409)
    }
    let vars = try placeholders(c, text: text)
    func fill(_ s: String) -> String {
      var out = "", last = 0
      let u = Array(s.utf16)
      for m in placeholder.all(s) {
        out += JSText.slice(u, last, m.start)
        let k = m.groups[0] ?? ""
        out += vars[k] ?? JSText.slice(u, m.start, m.end)
        last = m.end
      }
      return out + JSText.slice(u, last, u.count)
    }
    var steps: [TourStep] = []
    for st in tour["steps"]?.arrayValue ?? [] {
      let r = try resolveState(c, text: text, spec: st["state"] ?? .object([:]), relationships: relationships)
      steps.append(TourStep(n: st["n"]?.safeInteger ?? 0, action: fill(st["action"]?.stringValue ?? ""), see: fill(st["see"]?.stringValue ?? ""),
                            learn: fill(st["learn"]?.stringValue ?? ""), anchor: st["anchor"]?.stringValue ?? "", state: r.hash,
                            synthetic: st["synthetic"]?.boolValue != false, firstMinute: st["first_minute"]?.boolValue == true,
                            refs: .object(r.refs), pending: r.missing.isEmpty ? nil : r.missing, track: r.track.isEmpty ? nil : r.track))
    }
    let body = TourResponse(steps: steps, minutes: tour["minutes"]?.safeInteger)
    TourMemo.cache.withLock { $0[path] = (version, body) }
    return body
  }
}
