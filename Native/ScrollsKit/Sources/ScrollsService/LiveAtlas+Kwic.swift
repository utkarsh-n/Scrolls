// OWNER: N3
// Kwic in process (server/routes/kwic.mjs): the concordance — ±12 tokens from the original, clipped at the passage,
// sorted by date or spread (one per document first), 50 rows a page with the slice's denominator line on top. Either
// the slice of a registered timeline query (`q`), or the expression's default slice in its corpus; a saved view opened
// as saved passes its pinned runs and cutoffs (RF-2, D17), and then the counting run is the pinned one.

import Foundation
import ScrollsContracts
import ScrollsQuery
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func kwic(_ r: KwicRequest) async throws -> KwicResponse {
    let expr = r.expr?.rawValue
    let def: QueryDef
    if let q = r.q, !q.isEmpty {
      def = try await resolveDef(q)
    } else {
      guard let expr else {
        throw ScrollsError.badRequest(.validation, "expr (an expression id) or q (a queryKey) is required.",
                                      detail: .object(["field": .string("expr")]))
      }
      let (e, slug, pinned) = try await read { c -> (ExpressionRow?, String?, Int64?) in
        guard let e = try Expressions.get(c, expr) else { return (nil, nil, nil) }
        let slug = try r.corpus ?? Expressions.corpus(c, id: e.corpusId)?.slug
        return (e, slug, try Kwic.pinnedMaterializeRun(c, runs: r.runs, expr: expr))
      }
      guard e != nil else { throw ScrollsError(code: .notFound, message: "No expression \(expr).", status: 404) }
      guard let corpus = slug else {
        throw ScrollsError.badRequest(.validation, "corpus is required for an expression tracked across corpora.",
                                      detail: .object(["field": .string("corpus")]))
      }
      let importBatch = r.importBatch?.rawValue
      let at = r.at.flatMap { $0.isEmpty ? nil : $0 }
      let cutoffs = importBatch != nil || at != nil ? CanonicalRequest.Cutoffs(importBatch: importBatch, at: at) : nil
      if pinned == nil { _ = try await ensureMaterialized(expr) }
      let req = try CanonicalRequest.simple(corpus: corpus, strands: [.init(type: "expression", ref: .int(Int(expr)))],
                                            facet: r.facet ?? "language", f: r.f ?? "",
                                            runs: pinned.map { [String(expr): $0] } ?? [:], cutoffs: cutoffs)
      def = try await read { c in try QueryDefs.build(c, req).def }
    }
    let text = TextAccess(store: self.text)
    return try await read { c in
      try Kwic.query(c, text: text, def, expr: expr, from: r.from, to: r.to, lane: r.lane.flatMap { $0.isEmpty ? nil : $0 },
                     sort: r.sort ?? "date", cursor: r.cursor.flatMap { $0.isEmpty ? nil : $0 }, limit: r.limit ?? 50)
    }
  }
}
