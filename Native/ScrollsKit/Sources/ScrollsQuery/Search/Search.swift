// OWNER: N3
// Port of server/routes/search.mjs (SPEC §7.1, D16): typed suggestions (expression · work · maker · theme · etymology ·
// annotation), KWIC and titles. Counts are exact and use the timeline's slice under the same filters (default toggles): a
// tracked expression reads its materialized run; an untracked one is matched on the fly over its FTS candidates (up to
// 5,000 passages; beyond that the hits are FTS passage counts labelled preliminary). Trigram typeahead over titles only
// suggests; it never counts (§4.4). Empty results are computed, with the variants tried (§8.8).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Search.
public enum Search {
  static let scopes = ["all", "text", "titles", "works", "makers", "themes", "etymology", "annotations"]
  static let maxExactCandidates = 5000

  static func wants(_ scope: String, _ kinds: String...) -> Bool { scope == "all" || kinds.contains(scope) }

  /// A document's facts (docInfo).
  struct DocInfo {
    var id: Int64
    var title: String?
    var kind: String
    var yLo: Int?
    var loDay: Int?
    var hiDay: Int?
    var precision: String
    var dateLabel: String
    var chronoStatus: String
    var isSynthetic: Bool
  }

  static func docInfo(_ c: Connection, _ ids: [Int64]) throws -> [Int64: DocInfo] {
    if ids.isEmpty { return [:] }
    let s = try c.prepared(SearchSQL.docInfo)
    try s.bind([.text(SQLJSON.ints(ids))])
    var out: [Int64: DocInfo] = [:]
    for d in try s.all({ r in
      DocInfo(id: r.int(0), title: r.textOrNil(1), kind: r.text(2), yLo: r.intOrNil(4).map(Int.init), loDay: r.intOrNil(6).map(Int.init),
              hiDay: r.intOrNil(7).map(Int.init), precision: r.text(8), dateLabel: r.text(9), chronoStatus: r.text(10),
              isSynthetic: r.int(11) == 1)
    }) { out[d.id] = d }
    return out
  }

  static func yearOf(_ d: DocInfo) -> Int? { d.chronoStatus != "undated" ? d.yLo : nil }
  static func workLabel(_ d: DocInfo) -> String {
    "\(d.title ?? "(untitled)") — \(d.kind)\(yearOf(d) != nil ? " · \(d.dateLabel)" : " · undated")\(d.isSynthetic ? " (synthetic)" : "")"
  }

  /// A variant the search counts or offers.
  struct SVariant {
    var id: Int64
    var form: String
    var norm: String
    var lang: String?
    var type: String
    var rule: String?
    var status: String
    var enabled: Bool
  }

  /// The tracked expression in the scope (scopePayload): its payload, summed over the members of a virtual corpus.
  struct Tracked {
    var info: ExpressionInfo
    var status: String
    var job: Int?
    var run: RunID?
    var n: Int?
    var variants: [Variant]
  }

  static func scopePayload(_ c: Connection, _ ids: [Int64], _ scope: CorpusScope) throws -> Tracked? {
    var all: [ExpressionResponse] = []
    for id in ids {
      let j = try Expressions.latestMaterializeJob(c, id).map { Expressions.JobState(id: $0.id, status: $0.status) }
      guard let p = try Expressions.payload(c, id, job: j) else { return nil }
      all.append(p)
    }
    guard let lead = all.first else { return nil }
    if !scope.virtual {
      return Tracked(info: lead.expression, status: lead.state.status, job: lead.state.job, run: lead.state.run, n: lead.state.n,
                     variants: lead.variants)
    }
    let states = all.map(\.state)
    let status = states.contains { $0.status == "materializing" } ? "materializing"
      : states.allSatisfy { $0.status == "ready" } ? "ready" : states.contains { $0.status == "failed" } ? "failed" : "none"
    let n: Int? = states.allSatisfy { $0.n != nil } ? states.reduce(0) { $0 + $1.n! } : nil
    let variants = lead.variants.map { v -> Variant in
      let same = all.map { p in p.variants.first { $0.form == v.form && $0.lang == v.lang } }
      var out = v
      out.n = same.allSatisfy { $0?.n != nil } ? same.reduce(0) { $0 + $1!.n! } : nil
      return out
    }
    var info = lead.expression
    info.corpus = scope.slug
    return Tracked(info: info, status: status, job: states.compactMap(\.job).first, run: status == "ready" ? states[0].run : nil, n: n,
                   variants: variants)
  }

  /// `searchQuery(db, {q, corpus, scope, f, limit, lang})`.
  public static func query(_ c: Connection, text: TextAccess, q: String, corpus corpusSlug: String = "demo", scope scopeName: String = "all",
                           f: String = "", limit: Int = 20, lang: String? = nil) throws -> SearchResponse {
    let surface = JSString.trim(q)
    let tokens = Tokenizer.tokens(surface).tokens
    if tokens.isEmpty {
      throw ScrollsErrorFactory.validation("The search is empty.", field: "q", hint: "Type a word, a phrase, a title, a maker or a theme.")
    }
    guard scopes.contains(scopeName) else {
      throw ScrollsErrorFactory.validation("scope must be one of \(scopes.joined(separator: ", ")).", field: "scope")
    }
    let scope = try Scopes.resolve(c, corpusSlug)
    let lim = max(1, min(200, limit))
    let norm = tokens.joined(separator: " ")
    let kind = Variants.kindOfTokens(tokens)
    var tracked: [String?] = []
    if lang == nil || lang == "" {
      let s = try c.prepared(MatchSQL.exprLangsInScope)
      try s.bind([.text(kind), .text(norm), .text(SQLJSON.ints(scope.ids))])
      tracked = try s.all { $0.textOrNil(0) }
    }
    let l: String?
    if let lang, !lang.isEmpty { l = lang } else if tracked.count == 1 { l = tracked[0] } else {
      l = try Expressions.guessLanguage(c, tokens: tokens, corpusId: scope.ids[0])
    }
    let generated = Variants.generate(surface, lang: l)
    var own: [Int64?] = []
    for id in scope.ids {
      own.append(try c.prepared(MatchSQL.exprInCorpus).bindingFirst([.text(kind), .text(l ?? ""), .text(norm), .int(id)]) { $0.int(0) })
    }
    let existing: Int64? = own.allSatisfy { $0 != nil } ? own[0] : nil
    let payload = try existing.flatMap { _ in try scopePayload(c, own.map { $0! }, scope) }
    var variants: [SVariant]
    if let existing {
      variants = try Expressions.variants(c, existing).map {
        SVariant(id: $0.id, form: $0.form, norm: $0.norm, lang: $0.lang, type: $0.variantType, rule: $0.rule, status: $0.evidenceStatus,
                 enabled: $0.enabled)
      }
    } else {
      variants = [SVariant(id: 0, form: surface, norm: norm, lang: l, type: "identity", rule: "identity", status: "documented", enabled: true)]
      for (i, g) in generated.enumerated() {
        variants.append(SVariant(id: Int64(i + 1), form: g.form, norm: g.norm, lang: g.lang, type: g.type, rule: g.rule, status: g.status,
                                 enabled: g.enabled))
      }
      for (i, t) in try Translit.candidates(c, surface).enumerated() {
        variants.append(SVariant(id: Int64(generated.count + i + 1), form: t.form, norm: t.norm, lang: nil, type: "transliteration",
                                 rule: Translit.rule, status: "computed", enabled: false))
      }
    }
    let enabled = variants.filter(\.enabled)
    let langs = Expressions.strandLanguages(lang: l, variants: enabled.map { ($0.lang, true, $0.norm, $0.type) })
    var suggestions: [SearchSuggestion] = []
    var hits = SearchHits(passages: 0, documents: 0, undated: 0, namesExcluded: 0, preliminary: false)
    var kwic: [KwicRow] = []
    var titles: [SearchTitle] = []
    var byVariant: [Int64: Int] = [:]
    var total = 0
    var runIds: [(expr: Int64, run: Int64)]?

    if wants(scopeName, "text", "titles", "works") {
      if let existing, let run = payload?.run {
        _ = run
        let req = try CanonicalRequest.simple(corpus: scope.slug, strands: [.init(type: "expression", ref: .int(Int(existing)))],
                                              facet: "modality", f: f)
        let def = try QueryDefs.build(c, req).def
        let strand = def.strands[0]
        runIds = (strand.members ?? []).compactMap { m in m.ref.flatMap { r in m.run.map { (r, $0) } } }
        let qs = try SliceSQL.occurrences(def, strand)
        let docRows = try Slices.strandDocRows(c, def, strand)
        let counted = docRows.filter { $0.v > 0 }
        total = docRows.reduce(0) { $0 + Slices.countValue($1.uc, $1.v) }
        hits.passages = counted.reduce(0) { $0 + $1.passages }
        hits.documents = Set(counted.map(\.doc)).count
        hits.undated = Set(counted.filter { $0.chronoStatus == "undated" }.map(\.doc)).count
        if strand.sampled { hits.contextsSampled = true }
        for v in payload?.variants ?? [] { if let n = v.n { byVariant[Int64(v.id)] = n } }
        hits.namesExcluded = def.toggle("nm") == 1 ? 0 : docRows.reduce(0) { $0 + $1.names }
        let krows = try TimelineLists.runOcc(c, qs, order: "lo_day IS NULL, lo_day, occ", limit: lim, extra: " AND uc = 'text'")
        kwic = try Kwic.rows(c, text: text, krows.map { Kwic.Source($0, lane: Lanes.key("modality", $0.lv, $0.uc)) })
        let tdocs = try SliceSQL.all(c, SQLPart(OccSQL.distinctDocs(qs.sql, extra: " AND uc = 'titles'"), qs.params + [.int(Int64(lim))])) {
          $0.int(0)
        }
        let info = try docInfo(c, tdocs)
        titles = tdocs.compactMap { info[$0] }.map {
          SearchTitle(documentId: DocumentID(rawValue: $0.id), title: $0.title ?? "", kind: $0.kind, year: yearOf($0), synthetic: $0.isSynthetic)
        }
      } else {
        let def = QueryDef(corpus: scope.slug, corpusId: scope.ids[0], corpusIds: scope.ids, virtual: scope.virtual,
                           synthetic: scope.synthetic,
                           strands: [DefStrand(type: "expression", ref: .int(Int(existing ?? 0)), key: "search", run: nil, langs: langs,
                                               synthetic: scope.synthetic, sampled: false, accentInsensitive: false)],
                           lanes: .init(facet: "modality", order: "first_observed", max: 10, manual: []),
                           f: { var w: [String] = []; return ViewState.parseFilter(f, warnings: &w) }(),
                           toggles: zip(Vocab.toggleDefaults.keys, Vocab.toggleDefaults.values).map { ($0, $1) }, timeBasis: "publication",
                           cutoffs: nil, cluster: nil)
        let seqs = enabled.map { VariantSeq(id: $0.id, seq: JSString.split($0.norm, " ")) }
        let r = try onTheFly(c, text: text, def, scope, seqs, langs.map { LangSpec.list($0) } ?? .any)
        if r.preliminary {
          var passages = 0, documents = 0
          for id in scope.ids {
            let h = try FTS.hitCounts(c, phrases: seqs.map(\.seq), corpusId: id)
            passages += h.passages
            documents += h.documents
          }
          hits.passages = passages
          hits.documents = documents
          hits.preliminary = true
        } else {
          let info = try docInfo(c, Array(r.docs))
          hits.passages = r.passages.count
          hits.documents = r.docs.count
          hits.namesExcluded = r.names
          hits.undated = r.docs.filter { info[$0]?.chronoStatus == "undated" }.count
          byVariant = r.byVariant
          let textHits = stableSorted(r.kwic.filter { $0.p.fieldClass != "title" }) { a, b in
            Double(info[a.p.documentId]?.loDay ?? Int.max) < Double(info[b.p.documentId]?.loDay ?? Int.max)
          }
          total = textHits.count + r.titleDocs.count
          kwic = try Kwic.rows(c, text: text, textHits.prefix(lim).map { h in
            let d = info[h.p.documentId]
            return Kwic.Source(occ: nil, passage: h.p.id, doc: h.p.documentId, field: h.p.field, pStart: h.p.startOff, pEnd: h.p.endOff,
                               startOff: h.m.start, endOff: h.m.end, title: d?.title, loDay: d?.loDay, hiDay: d?.hiDay,
                               precision: d?.precision, dateLabel: d?.dateLabel, lane: Lanes.key("modality", "text", "text"),
                               synthetic: d?.isSynthetic ?? false)
          })
          titles = r.titleDocs.prefix(lim).compactMap { info[$0] }.map {
            SearchTitle(documentId: DocumentID(rawValue: $0.id), title: $0.title ?? "", kind: $0.kind, year: yearOf($0), synthetic: $0.isSynthetic)
          }
        }
      }
      let label = "\(surface) (\(kind), \(l ?? "any language"))"
      suggestions.append(SearchSuggestion(type: "expression", label: label, ref: existing.map { "expression:\($0)" } ?? "expression:new",
                                          count: hits.preliminary ? nil : total, preliminary: hits.preliminary))
    }
    if wants(scopeName, "works", "titles") {
      var seen = Set<Int64>()
      for t in titles.prefix(5) {
        guard let d = try docInfo(c, [t.documentId.rawValue])[t.documentId.rawValue] else { continue }
        seen.insert(t.documentId.rawValue)
        suggestions.append(SearchSuggestion(type: "work", label: workLabel(d), ref: "document:\(d.id)", count: nil))
      }
      if surface.utf16.count >= 3 {
        var rows: [(label: String, ref: String)] = []
        for id in scope.ids { rows += try trigram(c, surface, kind: "title", corpusId: id, limit: 10) }
        for r in rows {
          guard let id = Int64(JSString.split(r.ref, ":")[safe: 1] ?? "") else { continue }
          if seen.contains(id) || seen.count >= 8 { continue }
          seen.insert(id)
          if let d = try docInfo(c, [id])[id] {
            suggestions.append(SearchSuggestion(type: "work", label: workLabel(d), ref: "document:\(id)", count: nil, typeahead: true))
          }
        }
      }
    }
    if wants(scopeName, "makers") {
      var list: [SearchSuggestion] = []
      for id in scope.ids {
        let index = try TagIndex.index(c, corpusId: id, scheme: "maker")
        list += TagIndex.find(index, tokens.joined(separator: " "), limit: 5).map { makerSuggestion($0.value, $0.n) }
      }
      suggestions += merge(list)
    }
    if wants(scopeName, "themes") {
      var list: [SearchSuggestion] = []
      for id in scope.ids {
        let index = try TagIndex.index(c, corpusId: id, scheme: "theme")
        list += TagIndex.find(index, tokens.joined(separator: " "), limit: 5).map { r in
          SearchSuggestion(type: "theme", label: "\(r.value) (theme)", ref: "theme:\(r.value)", count: r.n,
                           provenance: JSString.split(r.provenance.joined(separator: ","), ","))
        }
      }
      suggestions += merge(list)
    }
    if wants(scopeName, "etymology") { suggestions += try etymology(c, tokens, l) }
    if wants(scopeName, "annotations") { suggestions += annotations(c, tokens) }
    if scopeName == "all" && scope.slug != "demo" { suggestions += try adapters(c) }

    let identityCount = (runIds != nil && total == 0) ? 0 : byVariant[variants[0].id] ?? 0
    var emptyNote: String?
    if !hits.preliminary && wants(scopeName, "text", "titles", "works") && identityCount == 0 {
      emptyNote = try emptyNoteFor(c, scope, surface, variants, runIds != nil && total == 0 ? [:] : byVariant, titles, langs)
    }
    let queryVariants = variants.filter { $0.type != "identity" }.map { v in
      SearchVariant(form: v.form, type: v.type, rule: v.rule, status: v.status, enabled: v.enabled,
                    n: hits.preliminary ? nil : byVariant[v.id])
    }
    var expression: SearchExpression?
    if let p = payload {
      expression = SearchExpression(id: p.info.id, surface: p.info.surface, norm: p.info.norm, kind: p.info.kind, lang: p.info.lang,
                                    state: p.status, n: p.n, job: p.job, synthetic: p.info.synthetic, corpus: p.info.corpus)
      expression?.$n = p.n.map { .value($0) } ?? .null
      expression?.$job = p.job.map { .value($0) } ?? .null
    }
    let provStrands: [DefStrand]
    if let existing, let runs = runIds, let run = runs.first(where: { $0.expr == existing })?.run {
      provStrands = [DefStrand(type: "expression", ref: .int(Int(existing)), key: String(existing), run: run,
                               members: runs.map { StrandMember(corpusId: 0, corpus: "", ref: $0.expr, run: $0.run, langs: nil, sampled: false,
                                                                accentInsensitive: false) },
                               synthetic: false, sampled: false, accentInsensitive: false)]
    } else {
      provStrands = []
    }
    var out = SearchResponse(query: SearchQuery(surface: surface, norm: norm, tokens: tokens, kind: kind, variants: queryVariants, lang: l),
                             suggestions: suggestions, expression: expression, hits: hits, kwic: kwic, titles: titles, emptyNote: emptyNote,
                             provenance: try Slices.provenance(c, corpus: scope.slug, corpusIds: scope.ids, virtual: scope.virtual,
                                                               synthetic: scope.synthetic, strands: provStrands))
    if l == nil { out.query.lang = nil }
    return out
  }

  /// The exact counts of an untracked expression under a def.
  struct OnTheFly {
    var preliminary: Bool
    var byVariant: [Int64: Int] = [:]
    var passages = Set<Int64>()
    var docs: [Int64] = []
    var titleDocs: [Int64] = []
    var names = 0
    var kwic: [(p: CandidatePassage, m: PassageMatch)] = []
  }

  static func onTheFly(_ c: Connection, text: TextAccess, _ def: QueryDef, _ scope: CorpusScope, _ seqs: [VariantSeq],
                       _ langs: LangSpec) throws -> OnTheFly {
    let phrases = seqs.map(\.seq)
    var budget = maxExactCandidates
    for id in scope.ids {
      budget -= try FTS.sample(c, phrases: phrases, corpusId: id, cap: budget + 1).count
      if budget < 0 { return OnTheFly(preliminary: true) }
    }
    var found: [PassageMatches] = []
    for id in scope.ids {
      let ids = try FTS.candidates(c, phrases: phrases, corpusId: id)
      let inSlice = try sliceFilter(c, def, ids, langs)
      let rows = try FTS.passageRows(c, ids.filter { inSlice.contains($0) })
      found += try Matching.matchPassages(c, text: text, rows, seqs, names: try Materializer.corpusNames(c, id))
    }
    var r = OnTheFly(preliminary: false)
    for s in seqs { r.byVariant[s.id] = 0 }
    var docSet = Set<Int64>(), titleSet = Set<Int64>()
    for f in found {
      for m in f.matches {
        if m.nameFlag && def.toggle("nm") == 0 {
          r.names += 1
          continue
        }
        r.byVariant[m.variantId, default: 0] += 1
        r.passages.insert(f.passage.id)
        if docSet.insert(f.passage.documentId).inserted { r.docs.append(f.passage.documentId) }
        if f.passage.fieldClass == "title" && titleSet.insert(f.passage.documentId).inserted { r.titleDocs.append(f.passage.documentId) }
        r.kwic.append((f.passage, m))
      }
    }
    return r
  }

  static func sliceFilter(_ c: Connection, _ def: QueryDef, _ ids: [Int64], _ langs: LangSpec) throws -> Set<Int64> {
    if ids.isEmpty { return [] }
    let cols = RowCols("p", passage: true)
    let a = SliceSQL.docWhere(def), b = SliceSQL.rowWhere(def, cols, langs)
    return Set(try SliceSQL.all(c, SQLPart(SearchSQL.sliceFilter(doc: a.sql, row: b.sql), [.text(SQLJSON.ints(ids))] + a.params + b.params)) {
      $0.int(0)
    })
  }

  static func trigram(_ c: Connection, _ text: String, kind: String, corpusId: Int64, limit: Int) throws -> [(label: String, ref: String)] {
    let q = "\"\(JSString.split(text, "\"").joined(separator: "\"\""))\""
    do {
      let s = try c.prepared(SearchSQL.trigram)
      try s.bind([.text(q), .text(kind), .int(corpusId), .int(Int64(limit))])
      return try s.all { ($0.text(0), $0.text(1)) }
    } catch {
      return []
    }
  }

  static func makerSuggestion(_ name: String, _ n: Int) -> SearchSuggestion {
    SearchSuggestion(type: "maker", label: "\(name) — \(Format.count(Double(n))) document\(n == 1 ? "" : "s")", ref: "maker:\(IDs.slug(name))",
                     count: n, name: name)
  }

  /// `mergeSuggestions`: the same maker or theme once, counts added up, most first, at most 5.
  static func merge(_ list: [SearchSuggestion]) -> [SearchSuggestion] {
    var by = OrderedDict<String, SearchSuggestion>()
    for x in list {
      let k = "\(x.type)|\(x.ref)"
      guard var a = by[k] else {
        by[k] = x
        continue
      }
      a.count = (a.count ?? 0) + (x.count ?? 0)
      if x.type == "maker" { a.label = "\(a.name ?? "undefined") — \(Format.count(Double(a.count ?? 0))) document\(a.count == 1 ? "" : "s")" }
      by[k] = a
    }
    return Array(stableSorted(by.values) { ($0.count ?? 0) > ($1.count ?? 0) }.prefix(5))
  }

  static func etymology(_ c: Connection, _ tokens: [String], _ lang: String?) throws -> [SearchSuggestion] {
    if tokens.count != 1 { return [] }
    if try c.prepared(SearchSQL.anyEtymon).first({ _ in true }) == nil { return [] }
    let s = try c.prepared(lang != nil ? SearchSQL.etymologyByLang : SearchSQL.etymologyAnyLang)
    try s.bind(lang.map { [.text($0), .text(tokens[0])] } ?? [.text(tokens[0])])
    let rows = try s.all { ($0.text(0), $0.text(1), $0.text(2), $0.textOrNil(3)) }
    if rows.isEmpty {
      return [SearchSuggestion(type: "etymology", label: "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE only)",
                               ref: "etymon:none", count: nil)]
    }
    return rows.map { r in
      let gloss = r.3.flatMap { $0.isEmpty ? nil : " '\($0)'" } ?? ""
      return SearchSuggestion(type: "etymology", label: "\(r.2) (\(r.1))\(gloss) — listed by Wiktionary (via kaikki.org)", ref: "etymon:\(r.0)",
                              count: nil)
    }
  }

  static func annotations(_ c: Connection, _ tokens: [String]) -> [SearchSuggestion] {
    do {
      let q = "\"\(JSString.split(tokens.joined(separator: " "), "\"").joined(separator: "\"\""))\""
      let n = Int(try c.prepared(SearchSQL.annotationMentions).bindingFirst([.text(q)]) { $0.int(0) } ?? 0)
      return n > 0 ? [SearchSuggestion(type: "annotation", label: "\(Format.count(Double(n))) annotation\(n == 1 ? " mentions" : "s mention") it",
                                       ref: "annotations", count: n)] : []
    } catch {
      return []
    }
  }

  static func adapters(_ c: Connection) throws -> [SearchSuggestion] {
    let rows = try c.prepared(SearchSQL.unloadedAdapters).all { $0.text(0) }
    return rows.isEmpty ? [] : [SearchSuggestion(type: "adapter", label: "STEMM sources not loaded yet: \(rows.joined(separator: ", "))",
                                                 ref: "adapters", count: nil)]
  }

  /// `emptyNoteFor`: what was searched, how big the index is, what the variants found.
  static func emptyNoteFor(_ c: Connection, _ scope: CorpusScope, _ surface: String, _ variants: [SVariant], _ byVariant: [Int64: Int],
                           _ titles: [SearchTitle], _ langs: [String]?) throws -> String {
    let cubes = try scope.ids.map { try Cubes.cube(c, $0) }
    let size = CubeSlice.corpusSize(cubes, langs)
    var parts: [String] = []
    if size.tokens > 0 { parts.append("\(Format.tokens(size.tokens)) tokens of full text\(size.lastText.map { " to \($0)" } ?? "")") }
    if size.works > 0 { parts.append("\(Format.count(Double(size.works))) titles") }
    var note = "No occurrences of '\(surface)' in the loaded corpus\(parts.isEmpty ? "" : " (\(parts.joined(separator: "; ")))")."
    for v in variants where v.type != "identity" && (byVariant[v.id] ?? 0) > 0 {
      let n = byVariant[v.id]!
      let what = v.type == "inflection" ? "the \(JSString.hasSuffix(v.form, "s") ? "plural" : "inflected") variant '\(v.form)'"
        : "the variant '\(v.form)' (\(v.type))"
      let sample = titles.first.map { t in " — \(t.title) (\(t.kind)\(t.year.map { ", \($0)" } ?? ""))" } ?? ""
      note += " With \(what): \(Format.count(Double(n))) match\(n == 1 ? "" : "es")\(sample)."
    }
    return "\(note) 0 is an observation about this index, not about culture."
  }
}
