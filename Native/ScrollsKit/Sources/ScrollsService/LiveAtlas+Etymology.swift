// OWNER: N2
// Etymology in process (server/routes/etymology.mjs; SPEC §1.7, §6.7, §10.5): the families of a tracked expression from
// Cipher's roots data (roots.tsv → etymon, etymon_parent, etymon_member): every etymon or root whose member list holds
// one of the expression's enabled single-word variants in its language, with its listed parents and parent_semantics,
// so the Scroll can draw the listed-roots bracket. These are language periods, not dates, and a multi-parent list is
// never presented as competing hypotheses (SPEC §13 rule 12). `roots` lists every listed parent once with the families
// that list it (C5); a parent listed by more than one family carries `shared: true` in `families[].parents`.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsQuery
import ScrollsStore

/// The statements of the etymology route (index lookups only: etymon_member(lang, norm) and primary keys).
public enum EtymologySQL: SQLCatalog {
  static let any = SQL("etymology.any", "SELECT 1 FROM etymon LIMIT 1", scan: .scanOK(reason: "LIMIT 1 probe"))
  static let members = SQL("etymology.members",
                           "SELECT key, lang, word, rank FROM etymon_member WHERE lang = ? AND norm = ? ORDER BY rank")
  static let etymon = SQL("etymology.etymon", "SELECT key, lang, form, roman, gloss, kind, parent_semantics FROM etymon WHERE key = ?")
  static let parents = SQL("etymology.parents", """
    SELECT e.key, e.lang, e.form, e.roman, e.gloss, e.kind FROM etymon_parent p JOIN etymon e ON e.key = p.parent_key
    WHERE p.key = ? AND p.parent_key <> p.key ORDER BY p.ord
    """)
  public static let all: [SQL] = [any, members, etymon, parents]
}

extension LiveAtlas {
  static let etymologySource = "Wiktionary via kaikki.org (CC BY-SA), as listed in Cipher's roots data"
  static let etymologyNoFamily = "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE only)"
  static let etymologyMaxFamilies = 8

  @concurrent
  public func etymology(_ r: EtymologyRequest) async throws -> EtymologyResponse {
    guard r.expr.rawValue > 0 else {
      throw ScrollsError.badRequest(.validation, "expr must be an expression id.", hint: "Use ?expr=12.", detail: ["field": "expr"])
    }
    return try await read { c in try LiveAtlas.etymologyOf(c, r.expr.rawValue) }
  }

  /// `etymologyOf(db, exprId)`.
  static func etymologyOf(_ c: Connection, _ exprID: Int64) throws -> EtymologyResponse {
    guard let expr = try Expressions.get(c, exprID) else {
      throw ScrollsError(code: .notFound, message: "No expression \(exprID).", hint: "Track the word first (POST /api/expressions).",
                         status: 404)
    }
    var words: [(lang: String, norm: String)] = []
    for v in try Expressions.variants(c, exprID) where v.enabled {
      let toks = Tokenizer.tokens(v.form).tokens
      guard toks.count == 1 else { continue }
      let lang = String(decoding: Array((v.lang ?? expr.lang ?? "").utf16.prefix(2)), as: UTF16.self)
      if !lang.isEmpty { words.append((lang, toks[0])) }
    }
    func base(available: Bool, reason: String? = nil) -> EtymologyResponse {
      EtymologyResponse(available: available, expression: ExpressionID(rawValue: expr.id), word: expr.surface, lang: expr.lang,
                        reason: reason, source: etymologySource)
    }
    if words.isEmpty {
      return base(available: false, reason: expr.lang != nil ? "Etymology families are listed for single words only."
                    : "Etymology families are listed for words of a known language.")
    }
    if try c.prepared(EtymologySQL.any).first({ _ in true }) == nil {
      return base(available: false, reason: "Cipher's roots data is not loaded yet (bootstrap phase A loads it).")
    }
    // etymon key → members, in first-seen order
    var order: [String] = []
    var members: [String: [(lang: String, word: String, rank: Int64)]] = [:]
    let m = try c.prepared(EtymologySQL.members)
    for w in words {
      try m.bind(.text(w.lang), .text(w.norm))
      for row in try m.all({ (key: $0.text(0), lang: $0.text(1), word: $0.text(2), rank: $0.int(3)) }) {
        if members[row.key] == nil { order.append(row.key); members[row.key] = [] }
        if !members[row.key]!.contains(where: { $0.lang == row.lang && $0.word == row.word }) {
          members[row.key]!.append((row.lang, row.word, row.rank))
        }
      }
    }
    // a stable sort by each family's best (lowest) rank, as Array.prototype.sort is stable
    let ranked = order.enumerated().sorted { a, b in
      let ra = members[a.element]!.map(\.rank).min()!, rb = members[b.element]!.map(\.rank).min()!
      return ra != rb ? ra < rb : a.offset < b.offset
    }.map(\.element)
    var families: [EtymologyFamily] = []
    let e = try c.prepared(EtymologySQL.etymon), p = try c.prepared(EtymologySQL.parents)
    for key in ranked {
      try e.bind(.text(key))
      guard let row = try e.first({ (key: $0.text(0), lang: $0.text(1), form: $0.text(2), roman: $0.textOrNil(3), gloss: $0.textOrNil(4),
                                      kind: $0.text(5), semantics: $0.text(6)) }) else { continue }
      try p.bind(.text(key))
      let parents = try p.all { Etymon(key: $0.text(0), lang: $0.text(1), form: $0.text(2), roman: $0.textOrNil(3), gloss: $0.textOrNil(4),
                                       kind: $0.text(5)) }
      let list: JSONValue = .array(members[key]!.map {
        .object(["lang": .string($0.lang), "word": .string($0.word), "rank": .number(Double($0.rank))])
      })
      families.append(EtymologyFamily(key: row.key, lang: row.lang, form: row.form, roman: row.roman, gloss: row.gloss, kind: row.kind,
                                      parentSemantics: row.semantics, parents: parents, members: list))
      if families.count >= etymologyMaxFamilies { break }
    }
    let roots = dedupeRoots(&families)
    var out = base(available: true)
    out.families = families
    out.roots = roots
    out.note = families.isEmpty ? etymologyNoFamily : nil
    return out
  }

  /// `dedupeRoots(families)`: every listed parent once, in first-listed order, with the families that list it; marks
  /// the parents more than one family lists (`shared`).
  static func dedupeRoots(_ families: inout [EtymologyFamily]) -> [EtymologyRoot] {
    let familyKeys = Set(families.map(\.key))
    var order: [String] = []
    var byKey: [String: EtymologyRoot] = [:]
    for f in families {
      for p in f.parents {
        if var r = byKey[p.key] {
          if !r.families.contains(f.key) { r.families.append(f.key) }
          byKey[p.key] = r
        } else {
          order.append(p.key)
          byKey[p.key] = EtymologyRoot(key: p.key, lang: p.lang, form: p.form, roman: p.roman, gloss: p.gloss, kind: p.kind,
                                       families: [f.key], isFamily: familyKeys.contains(p.key))
        }
      }
    }
    for i in families.indices {
      for j in families[i].parents.indices where (byKey[families[i].parents[j].key]?.families.count ?? 0) > 1 {
        families[i].parents[j].shared = true
      }
    }
    return order.map { byKey[$0]! }
  }
}
