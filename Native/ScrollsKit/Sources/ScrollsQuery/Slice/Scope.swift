// OWNER: N3
// Port of server/aggregate/scope.mjs (contract 1.3.0, C2): which corpora a request reads. A slug names one corpus or a
// virtual corpus (vocab.VIRTUAL_CORPORA): `real` is every non-synthetic corpus that holds documents — the synthetic demo
// is never a member. An expression strand in `real` stands for its siblings (same kind, language and folded form) in
// every member corpus; each keeps its own variants, runs and exclusions, and a lane's count in `real` is the sum of the
// member corpora counted alone.

import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A member corpus.
public struct CorpusMember: Sendable, Equatable {
  public var id: Int64
  public var slug: String
  public var name: String
}

/// The corpora a slug reads.
public struct CorpusScope: Sendable, Equatable {
  public var slug: String
  public var name: String
  public var virtual: Bool
  public var ids: [Int64]
  public var members: [CorpusMember]
  public var synthetic: Bool
}

/// Corpus scopes.
public enum Scopes {
  /// `isVirtualCorpus(slug)`.
  public static func isVirtual(_ slug: String?) -> Bool { slug.map { Vocab.virtualCorpora[$0] != nil } ?? false }

  /// `realMembers(db)`: non-synthetic corpora with at least one live document, by id.
  public static func realMembers(_ c: Connection) throws -> [CorpusMember] {
    try c.prepared(ScopeSQL.realMembers).all { CorpusMember(id: $0.int(0), slug: $0.text(1), name: $0.text(2)) }
  }

  /// `resolveCorpusScope(db, slug)`.
  public static func resolve(_ c: Connection, _ slug: String) throws -> CorpusScope {
    if let v = Vocab.virtualCorpora[slug] {
      let members = try realMembers(c)
      if members.isEmpty {
        throw ScrollsError.badRequest(.validation, "No real corpus holds documents yet, so '\(slug)' is empty.",
                                      hint: "Load the Cipher corpus or a STEMM source first.",
                                      detail: .object(["field": .string("corpus")]))
      }
      return CorpusScope(slug: slug, name: v.name, virtual: true, ids: members.map(\.id), members: members, synthetic: false)
    }
    guard let k = try Expressions.corpus(c, slug: slug) else {
      throw ScrollsError.badRequest(.validation, "Unknown corpus '\(slug)'.",
                                    hint: "Use one of the corpora listed by GET /api/corpora, or real.",
                                    detail: .object(["field": .string("corpus")]))
    }
    return CorpusScope(slug: k.slug, name: k.name, virtual: false, ids: [k.id],
                       members: [CorpusMember(id: k.id, slug: k.slug, name: k.name)], synthetic: k.isSynthetic)
  }

  /// `siblingExpressions(db, expr, members)`: the expression with the same kind, language and norm in each member.
  public static func siblings(_ c: Connection, _ expr: ExpressionRow, _ members: [CorpusMember]) throws
    -> [(corpusId: Int64, corpus: String, expr: ExpressionRow?)]
  {
    try members.map { m in
      let e = try c.prepared(MatchSQL.exprInCorpus).bindingFirst([.text(expr.kind), .text(expr.lang ?? ""), .text(expr.norm), .int(m.id)],
                                                                 Expressions.exprRow)
      return (m.id, m.slug, e)
    }
  }

  /// The read half of `trackAcross`: the language decided once (an existing sibling's, the request's, or a guess in the
  /// first member) and a plan per member corpus.
  public static func planTrackAcross(_ c: Connection, surface: String, lang: String?, kind: String?, corpus: String,
                                     origin: String = "user_query", createdBy: String = "user") throws -> [Expressions.TrackPlan] {
    let scope = try resolve(c, corpus)
    let tokens = Tokenizer.tokens(JSString.trim(surface)).tokens
    var l: String? = (lang == nil || lang == "") ? nil : JSString.toLowerCase(lang!)
    if l == nil && !tokens.isEmpty {
      let k = kind ?? Variants.kindOfTokens(tokens)
      let s = try c.prepared(MatchSQL.exprLangsInScope)
      try s.bind([.text(k), .text(tokens.joined(separator: " ")), .text(SQLJSON.ints(scope.ids))])
      let known = try s.all { $0.textOrNil(0) }
      l = known.count == 1 ? known[0] : try Expressions.guessLanguage(c, tokens: tokens, corpusId: scope.ids[0])
    }
    // an empty language string forces "any language" for every member (the plan never guesses again)
    return try scope.members.map { m in
      var p = try Expressions.planTrack(c, surface: surface, lang: l ?? "", kind: kind, corpus: m.slug, origin: origin, createdBy: createdBy)
      if l == nil {
        p.lang = nil
        p.generated = Variants.generate(p.surface, lang: nil)
      }
      return p
    }
  }
}

/// Statements of corpus scopes.
public enum ScopeSQL: SQLCatalog {
  static let realMembers = SQL("q.scope.real-members", """
    SELECT k.id, k.slug, k.name FROM corpus k WHERE k.is_synthetic = 0 AND k.slug <> 'demo'
      AND EXISTS (SELECT 1 FROM collection c WHERE c.corpus_id = k.id AND EXISTS (SELECT 1 FROM document d INDEXED BY doc_facets
        WHERE d.collection_id = c.id AND d.deleted_at IS NULL))
      ORDER BY k.id
    """, scan: .scanOK(reason: "corpora (a handful), one indexed probe each"))

  public static let all: [SQL] = [realMembers]
}
