// OWNER: N3
// Search in process (server/routes/search.mjs): typed suggestions (expressions, works, makers, themes, etymology,
// annotations), trigram typeahead over `label_tri` (suggested, never counted), FTS passage counts labelled
// "preliminary" until the expression is counted, a KWIC sample, matching titles, transliteration candidates
// ("shunya" → शून्य, offered as variants, never merged) and, for an empty result, the variants tried — "0 is an
// observation about this index, not about culture". The first search of a word reads its candidate documents, so it
// gets the timeline query's 15 s deadline (the reference's SEARCH_TIMEOUT_MS) instead of the 5 s interactive one.

import Foundation
import ScrollsContracts
import ScrollsQuery
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func search(_ r: SearchRequest) async throws -> SearchResponse {
    let limit = r.limit ?? 20
    guard limit >= 1 else {
      throw ScrollsError.badRequest(.badLimit, "limit must be a positive integer (got '\(limit)').", hint: "Use 1–200.")
    }
    let text = TextAccess(store: self.text)
    return try await reads.read(.interactive, deadline: .seconds(15)) { c in
      try Search.query(c, text: text, q: r.q, corpus: r.corpus ?? "demo", scope: r.scope ?? "all", f: r.f ?? "", limit: limit,
                       lang: r.lang)
    }
  }
}
