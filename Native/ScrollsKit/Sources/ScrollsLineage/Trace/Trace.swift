// OWNER: N5
// Port of server/lineage/trace.mjs (SPEC §4.7): the targeted quotation trace of a span of ≥ 4 tokens of one passage.
//  · exact — FTS phrase windows of 8 tokens, then seed-and-extend: verified identical runs of ≥ 8 tokens;
//  · near — candidates from the LSH index of the latest reuse-index run covering the span's collection (its sentences
//    sharing a band key with the span's sentences) and from FTS (passages sharing the span's word 3-shingles),
//    verified by Smith–Waterman ≥ 0.75 of the shorter unit and 3-shingle Jaccard ≥ 0.5, over an aligned stretch of
//    ≥ 8 tokens (shorter ones are listed as similar wording);
//  · similar wording — FTS NEAR(…, 6) of the span's rarest content words: computed similarity, never quotation;
//  · attribution cues around the span that name the author (or title) of a matched document.
// The reuse index's exclusions apply: a span that is structure, wording held by more than 25 documents, or
// production-line text lists its matches but makes no links (`exclusion` says which and why). `TraceQuery.run` only
// reads; `TraceTask` (the 'trace' job) also writes the computed links of a 'trace' run: exact/near quotations directed
// by dates, shared wording otherwise, cue citations 'proposed'. Cross-language reuse is not detected, and the response
// says so. Text is read through the TextStore (D4 offsets), so the trace works on the device profile's chunks too.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

public enum TraceQuery {
  public static let pipelineVersion = "trace@1.1.0"
  static let productionWide = 25
  public static let minSpanTokens = 4
  public static let exactMin = 8
  public static let note = "Cross-language reuse is not detected."
  static let maxCandidates = 400
  static let maxList = 50
  static let nearScore = 0.75, nearJaccard = 0.5
  /// Body characters below which a text has no front or back matter (≈ 1,000 tokens).
  static let minBodyChars = 5000

  /// `ftsQuote(toks)`: one FTS5 phrase.
  static func ftsQuote(_ toks: [String]) -> String {
    "\"" + toks.joined(separator: " ").replacingOccurrences(of: "\"", with: "\"\"") + "\""
  }

  /// A field's text and (for the body) the original's sha256.
  struct FieldText: Sendable {
    var units: [UInt16]
    var sha: String?
  }

  static func fieldText(_ r: LineageReader, _ doc: Int64, _ field: String) throws -> FieldText {
    if field == "body" {
      let sha = try r.c.prepared(LineageSQL.originalSHA).bindingFirst([.int(doc)]) { $0.textOrNil(0) } ?? nil
      return FieldText(units: try r.body(doc), sha: sha)
    }
    return FieldText(units: try r.fieldText(doc, field) ?? [], sha: nil)
  }

  /// A checked span (`checkTraceRequest`).
  public struct Span: Sendable {
    var passage: LineageRef.Passage
    var docId: Int64
    var field: String
    var start: Int
    var end: Int
    var text: FieldText
    var tokens: [String]
    var starts: [Int]
    var ends: [Int]
  }

  /// `checkTraceRequest(db, body)`: offsets index the document text (D4); `relative` means the passage text.
  public static func check(_ r: LineageReader, _ req: TraceRequest) throws -> Span {
    guard let target = try LineageRefs.resolve(r.c, type: "passage", id: String(req.passage.rawValue)), let p = target.passage
    else { throw ScrollsError.lineageNotFound("No passage \(req.passage.rawValue).") }
    let shift = req.relative == true ? p.startOff : 0
    let start = req.start + shift, end = req.end + shift
    if start < p.startOff || end > p.endOff || start >= end {
      throw ScrollsError(code: .validation, message: "Span \(start)–\(end) is not inside passage \(req.passage.rawValue) (\(p.startOff)–\(p.endOff)).",
                         hint: "Offsets index the document text (D4); send relative: true for offsets into the passage text.",
                         detail: ["field": "start"], status: 400)
    }
    let t = try fieldText(r, p.documentId, p.field)
    let slice = slice(t.units, start, end)
    let tk = Tokenizer.tokens(slice)
    if tk.tokens.count < minSpanTokens {
      throw ScrollsError(code: .validation,
                         message: "A trace needs a span of at least \(minSpanTokens) tokens (this one has \(tk.tokens.count)).",
                         hint: "Select a longer span.",
                         detail: ["tokens": .number(Double(tk.tokens.count)), "min": .number(Double(minSpanTokens))], status: 400)
    }
    return Span(passage: p, docId: p.documentId, field: p.field, start: start, end: end, text: t, tokens: tk.tokens,
                starts: tk.starts.map { Int($0) + start }, ends: tk.ends.map { Int($0) + start })
  }

  /// `text.slice(a, b)` over code units.
  static func slice(_ u: [UInt16], _ a: Int, _ b: Int) -> String {
    let lo = Swift.min(Swift.max(0, a), u.count), hi = Swift.min(Swift.max(0, b), u.count)
    return lo < hi ? String(decoding: u[lo..<hi], as: UTF16.self) : ""
  }

  /// `nearIndexFor(db, docId)`: the stored index of the latest succeeded reuse-index run whose scope covers the
  /// document's collection, when its lsh.bin exists.
  public static func nearIndex(_ r: LineageReader, doc: Int64) throws -> (run: Int64, dir: URL)? {
    guard let coll = try r.c.prepared(LineageSQL.documentCollection).bindingFirst([.int(doc)], { ($0.int(0), $0.text(1)) }) else {
      return nil
    }
    let runs = try r.c.prepared(LineageSQL.reuseRuns).binding([]) { ($0.int(0), $0.textOrNil(1)) }
    for (id, scopeJSON) in runs {
      guard let s = scopeJSON, let scope = try? JSONValue.parse(s) else { continue }
      if let cs = scope["collections"]?.arrayValue {
        // Array.prototype.includes: a numeric element never equals the slug or String(id)
        let names = cs.compactMap(\.stringValue)
        if !names.contains(coll.1) && !names.contains(String(coll.0)) { continue }
      }
      let dir = Commonplaces.directory(atlasPath: r.atlasPath).appendingPathComponent("run-\(id)")
      if FileManager.default.fileExists(atPath: dir.appendingPathComponent("lsh.bin").path) { return (id, dir) }
    }
    return nil
  }

  /// A candidate passage row.
  struct Candidate {
    var id: Int64
    var documentId: Int64
    var field: String
    var startOff: Int
    var endOff: Int
    var unit: String?
  }

  static func candidateRow(_ row: ScrollsStore.Row) -> Candidate {
    Candidate(id: row.int(0), documentId: row.int(1), field: row.text(2), startOff: Int(row.int(3)), endOff: Int(row.int(4)),
              unit: row.textOrNil(5))
  }

  /// `candidates(db, match, exclude)`: ok passages of other live, non-duplicate documents matching an FTS query, best
  /// bm25 first, ≤ 400.
  static func candidates(_ r: LineageReader, _ match: String, exclude: Int64) throws -> [Candidate] {
    guard !match.isEmpty else { return [] }
    return try r.c.prepared(LineageSQL.traceCandidates).binding([.text(match), .int(exclude), .int(Int64(maxCandidates))], candidateRow)
  }

  /// `passageRow(db, id, exclude)`.
  static func passageRow(_ r: LineageReader, _ id: Int64, exclude: Int64) throws -> Candidate? {
    try r.c.prepared(LineageSQL.tracePassage).bindingFirst([.int(id), .int(exclude)], candidateRow)
  }

  /// A document as the trace shows it (`docCache`).
  struct Doc {
    var id: Int64
    var title: String?
    var author: String?
    var loDay: Int64?
    var hiDay: Int64?
    var yLo: Int64?
    var yHi: Int64?
    var chronoStatus: String
    var isSynthetic: Int64
    var dateLabel: String
  }

  final class Docs {
    let c: Connection
    var cache: [Int64: Doc] = [:]
    init(_ c: Connection) { self.c = c }
    func get(_ id: Int64) throws -> Doc? {
      if let d = cache[id] { return d }
      let d = try c.prepared(LineageSQL.traceDocument).bindingFirst([.int(id)]) { r in
        Doc(id: r.int(0), title: r.textOrNil(1), author: r.textOrNil(2), loDay: r.intOrNil(3), hiDay: r.intOrNil(4), yLo: r.intOrNil(5),
            yHi: r.intOrNil(6), chronoStatus: r.text(7), isSynthetic: r.int(8), dateLabel: r.text(9))
      }
      if let d { cache[id] = d }
      return d
    }
  }

  /// `passageTokens(db, c)`: the passage's text, tokens and ids.
  struct PassageTokens {
    var text: FieldText
    var local: [UInt16]
    var tk: TokenizedText
    var ids: [UInt32]
  }

  static func passageTokens(_ r: LineageReader, _ c: Candidate) throws -> PassageTokens {
    let t = try fieldText(r, c.documentId, c.field)
    let local = Array(slice(t.units, c.startOff, c.endOff).utf16)
    let tk = Tokenizer.tokens(String(decoding: local, as: UTF16.self))
    return PassageTokens(text: t, local: local, tk: tk, ids: Winnow.tokenIds(tk.tokens))
  }

  /// One match of the trace (exact, near or similar wording) with what the job needs to write its link.
  struct Match: Sendable {
    var passage: Int64
    var doc: Int64
    var json: JSONObject
    var start: Int = 0
    var end: Int = 0
    var tokens: Int = 0
    var score: Double?
    var jaccard: Double?
    var via: String?
    var spanStart: Int = 0
    var spanEnd: Int = 0
  }

  /// A cue found around the span that names a matched document.
  struct CitedCue: Sendable {
    var cue: Cues.Cue
    var passage: Int64
    var doc: Int64
    var title: String?
    var json: JSONValue {
      guard case .object(var o) = cue.json else { return cue.json }
      o["cited"] = ["passage": .number(Double(passage)), "doc": .number(Double(doc)), "title": title.map(JSONValue.string) ?? .null]
      return .object(o)
    }
  }

  /// What a trace found: the response body (without the run and the created links) and the rows the job writes.
  public struct Result: Sendable {
    public var body: JSONObject
    var span: Span
    var exact: [Match]
    var near: [Match]
    var cues: [CitedCue]
    var excluded: String?
  }

  /// `Math.round(x * 1000) / 1000`.
  static func round3(_ x: Double) -> Double { JSNumber.round(x * 1000) / 1000 }

  /// `traceQuery(db, args)`: the search (no writes).
  public static func run(_ r: LineageReader, _ req: TraceRequest) throws -> Result {
    let span = try check(r, req)
    let docs = Docs(r.c)
    let spanIds = Winnow.tokenIds(span.tokens)
    var exact: [Match] = [], near: [Match] = [], similar: [JSONValue] = []
    var seen = Set<Int64>()
    func entry(_ c: Candidate, _ extra: JSONObject) throws -> JSONObject {
      guard let d = try docs.get(c.documentId) else { return extra }
      var o: JSONObject = ["passage": .number(Double(c.id)), "doc": .number(Double(d.id)), "title": d.title.map(JSONValue.string) ?? .null,
                           "author": d.author.map(JSONValue.string) ?? .null, "date": .string(d.dateLabel),
                           "synthetic": .bool(d.isSynthetic == 1)]
      for (k, v) in extra { o[k] = v }
      return o
    }

    // exact: verified identical runs of ≥ 8 tokens
    if span.tokens.count >= exactMin {
      var windows: [String] = []
      var i = 0
      while i + exactMin <= span.tokens.count {
        windows.append(ftsQuote(Array(span.tokens[i..<(i + exactMin)])))
        i += 4
      }
      let last = ftsQuote(Array(span.tokens.suffix(exactMin)))
      if !windows.contains(last) { windows.append(last) }
      for c in try candidates(r, windows.joined(separator: " OR "), exclude: span.docId) {
        let t = try passageTokens(r, c)
        let runs = Align.seedExtend(spanIds, t.ids, Align.kgramSeeds(spanIds, t.ids, k: exactMin), minRun: exactMin)
        guard !runs.isEmpty else { continue }
        // runs.sort((x, y) => y.len - x.len)[0]: a stable sort, so the first of the longest
        var best = runs[0]
        for run in runs.dropFirst() where run.len > best.len { best = run }
        seen.insert(c.id)
        let s = Int(t.tk.starts[best.b0]), e = Int(t.tk.ends[best.b1 - 1])
        var m = Match(passage: c.id, doc: c.documentId, json: [:])
        m.start = c.startOff + s
        m.end = c.startOff + e
        m.tokens = best.len
        m.spanStart = span.starts[best.a0]
        m.spanEnd = span.ends[best.a1 - 1]
        m.json = try entry(c, ["start": .number(Double(m.start)), "end": .number(Double(m.end)), "tokens": .number(Double(best.len)),
                               "quote": .string(slice(t.local, s, e)),
                               "span": ["start": .number(Double(m.spanStart)), "end": .number(Double(m.spanEnd))]])
        exact.append(m)
        if exact.count >= maxList { break }
      }
    } else {
      for c in try candidates(r, ftsQuote(span.tokens), exclude: span.docId) {
        seen.insert(c.id)
        similar.append(.object(try entry(c, ["kind": "phrase",
                                             "note": .string("the same \(span.tokens.count) words; too short for a quotation (needs \(exactMin))")])))
        if similar.count >= maxList { break }
      }
    }

    // near: indexed sentences sharing an LSH band with the span's sentences, and passages sharing its 3-shingles
    let spanText = slice(span.text.units, span.start, span.end)
    let spanTok = Tokenizer.tokens(spanText)
    var spanUnits = MinHash.unitsOf(spanText, starts: spanTok.starts, ends: spanTok.ends)
    if spanUnits.isEmpty { spanUnits = [MinHash.Unit(t0: 0, t1: span.tokens.count)] }
    var nearOrder: [Int64] = []
    var nearCands: [Int64: (row: Candidate, via: String)] = [:]
    let index = try nearIndex(r, doc: span.docId)
    if let index {
      for su in spanUnits {
        for hit in NearIndex.lookup(index.dir, Array(spanIds[su.t0..<su.t1])) ?? [] {
          let pid = Int64(hit.passage)
          if nearCands[pid] != nil || seen.contains(pid) { continue }
          if let row = try passageRow(r, pid, exclude: span.docId) {
            nearOrder.append(row.id)
            nearCands[row.id] = (row, "lsh")
          }
        }
      }
    }
    var shingleQueries: [String] = []
    var i = 0
    while i + 3 <= span.tokens.count && shingleQueries.count < 30 {
      let tri = Array(span.tokens[i..<(i + 3)])
      if tri.contains(where: { !Filters.isStop($0) }) { shingleQueries.append(ftsQuote(tri)) }
      i += 1
    }
    var uniq: [String] = []
    var seenQ = Set<String>()
    for q in shingleQueries where seenQ.insert(q).inserted { uniq.append(q) }
    for c in try candidates(r, uniq.joined(separator: " OR "), exclude: span.docId) where nearCands[c.id] == nil {
      nearOrder.append(c.id)
      nearCands[c.id] = (c, "fts")
    }
    for pid in nearOrder {
      guard let (c, via) = nearCands[pid], !seen.contains(c.id) else { continue }
      let t = try passageTokens(r, c)
      var units = MinHash.unitsOf(t.local, starts: t.tk.starts, ends: t.tk.ends, verse: c.unit == "stanza")
      if units.isEmpty { units = [MinHash.Unit(t0: 0, t1: t.tk.tokens.count)] }
      var best: (sw: Align.SW, ja: Double, su: MinHash.Unit, u: MinHash.Unit)?
      for su in spanUnits {
        let a = Array(spanIds[su.t0..<su.t1]), sa = MinHash.shingles3(a)
        for u in units {
          let b = Array(t.ids[u.t0..<u.t1])
          let ja = MinHash.jaccard(sa, MinHash.shingles3(b))
          if ja < nearJaccard { continue }
          let sw = Align.smithWaterman(a, b)
          if sw.normalized < nearScore { continue }
          if best == nil || sw.normalized > best!.sw.normalized { best = (sw, ja, su, u) }
        }
      }
      guard let b = best else { continue }
      seen.insert(c.id)
      let b0 = b.u.t0 + b.sw.bStart, b1 = b.u.t0 + b.sw.bEnd
      let a0 = b.su.t0 + b.sw.aStart, a1 = b.su.t0 + b.sw.aEnd
      if a1 - a0 < exactMin {
        // a short aligned stretch is similar wording (a stock phrase, a formula), never a quotation
        if similar.count < maxList {
          similar.append(.object(try entry(c, ["kind": "near_short", "score": .number(round3(b.sw.normalized)),
                                               "note": .string("\(a1 - a0) aligned words; a near quotation needs \(exactMin)")])))
        }
        continue
      }
      let s = Int(t.tk.starts[b0]), e = Int(t.tk.ends[b1 - 1])
      var m = Match(passage: c.id, doc: c.documentId, json: [:])
      m.start = c.startOff + s
      m.end = c.startOff + e
      m.score = round3(b.sw.normalized)
      m.jaccard = round3(b.ja)
      m.via = via
      m.spanStart = span.starts[a0]
      m.spanEnd = span.ends[a1 - 1]
      m.json = try entry(c, ["start": .number(Double(m.start)), "end": .number(Double(m.end)), "score": .number(m.score!),
                             "jaccard": .number(m.jaccard!), "via": .string(via), "quote": .string(slice(t.local, s, e)),
                             "span": ["start": .number(Double(m.spanStart)), "end": .number(Double(m.spanEnd))]])
      near.append(m)
      if near.count >= maxList { break }
    }

    // similar wording: the rarest content words close together, in any order
    var content: [String] = []
    var seenC = Set<String>()
    for t in span.tokens where !Filters.isStop(t) && t.utf16.count > 1 && seenC.insert(t).inserted { content.append(t) }
    if content.count >= 2 {
      let rarity = try r.c.prepared(LineageSQL.vocabDocs)
      var rated: [(String, Int64, Int)] = []
      for (k, t) in content.enumerated() {
        try rarity.bind(.text(t))
        let n = try rarity.first { $0.int(0) } ?? 0
        if n > 0 { rated.append((t, n, k)) }
      }
      let words = rated.sorted { $0.1 != $1.1 ? $0.1 < $1.1 : $0.2 < $1.2 }.prefix(5).map(\.0)
      if words.count >= 2 {
        let match = "NEAR(\(words.map { ftsQuote([$0]) }.joined(separator: " ")), 6)"
        for c in try candidates(r, match, exclude: span.docId) {
          if seen.contains(c.id) { continue }
          similar.append(.object(try entry(c, ["kind": "near_words", "words": .array(words.map(JSONValue.string))])))
          if similar.count >= maxList { break }
        }
      }
    }

    // cues around the span naming the author or title of a matched document
    var cues: [CitedCue] = []
    let fullText = String(decoding: span.text.units, as: UTF16.self)
    for cue in Cues.findCues(fullText, start: span.start, end: span.end) where cue.name != nil && !cue.name!.isEmpty {
      for m in exact + near {
        guard let d = try docs.get(m.doc) else { continue }
        if Cues.nameMatches(cue.name, author: d.author, title: d.title) {
          cues.append(CitedCue(cue: cue, passage: m.passage, doc: m.doc, title: d.title))
        }
      }
    }
    let exclusion = try exclusionOf(r, span, spanIds, exact + near)
    let body: JSONObject = [
      "status": "done",
      "span": ["passage": .number(Double(span.passage.id)), "start": .number(Double(span.start)), "end": .number(Double(span.end)),
               "tokens": .number(Double(span.tokens.count)), "quote": .string(spanText)],
      "exact": .array(exact.map { .object($0.json) }),
      "near": .array(near.map { .object($0.json) }),
      "similar_wording": .array(similar),
      "cues": .array(cues.map(\.json)),
      "note": .string(exclusion.map { "\(note) \($0["note"]?.stringValue ?? "")" } ?? note),
      "near_index": index.map { ["run": .number(Double($0.run))] } ?? .null,
      "exclusion": exclusion.map(JSONValue.object) ?? .null,
    ]
    return Result(body: body, span: span, exact: exact, near: near, cues: cues, excluded: exclusion?["kind"]?.stringValue)
  }

  /// `traceExclusion(db, span, spanIds, matches)`: why the matches must not become quotation links.
  static func exclusionOf(_ r: LineageReader, _ span: Span, _ spanIds: [UInt32], _ matches: [Match]) throws -> JSONObject? {
    let spanText = slice(span.text.units, span.start, span.end)
    let classes = Filters.TokenClasses()
    for (k, t) in span.tokens.enumerated() { classes.see(t, spanIds[k]) }
    if !Filters.informative(spanIds, 0, spanIds.count, classes) || Filters.isNameList(spanText) {
      return ["kind": "structure", "note": "The span is numbering or a list of names or titles: matches are listed, no links are made."]
    }
    var docs = Set<Int64>([span.docId])
    for m in matches { docs.insert(m.doc) }
    if docs.count > productionWide {
      return ["kind": "widely_shared", "documents": .number(Double(docs.count)),
              "note": .string("This wording is held by \(docs.count) documents: widely shared text is one node, not pairs, so no links are made.")]
    }
    if docs.count >= Filters.Production.minDocs {
      let body = try r.c.prepared(LineageSQL.bodyBounds)
      func atEdge(_ doc: Int64, _ off: Int) throws -> Bool {
        try body.bind(.int(doc))
        guard let (b0, b1) = try body.first({ ($0.int(0), $0.int(1)) }) else { return false }
        if b1 - b0 < Int64(minBodyChars) { return false }
        let rel = Double(Int64(off) - b0) / Double(b1 - b0)
        return rel < Filters.Production.edge || rel >= 1 - Filters.Production.edge
      }
      let occ: [(Int64, Int)] = [(span.docId, span.start)] + matches.map { ($0.doc, $0.start) }
      var atEdges = 0
      for (d, o) in occ where try atEdge(d, o) { atEdges += 1 }
      if Double(atEdges) >= Filters.Production.edgeShare * Double(occ.count) {
        return ["kind": "production_line", "documents": .number(Double(docs.count)),
                "note": .string("This wording opens or closes \(docs.count) documents (production-line text such as a transcriber's note): matches are listed, no links are made.")]
      }
    }
    return nil
  }
}
