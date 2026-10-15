// OWNER: N4
// The expressions of a request (slices.mjs `resolveExpressions`): each with its enabled variants, the passage languages
// it is counted in and divided by (materialize.mjs `strandLanguages`, the timeline's rule, so Compare's n and
// denominators equal the tiles'), and the materialize run whose counts are read — the run a saved view pinned (as saved,
// RF-2), else expression_state.run_id when that run succeeded, else the newest succeeded materialize run with rows for
// it. Also the RF-1 language gate (aggregate/langgate.mjs `langAdmits`). These are ported here, beside their only
// readers in this module, from the reference files N3 ports for the timeline; the rule is one and the goldens of both
// packages pin it.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// One enabled variant of an expression.
public struct ResolvedVariant: Sendable, Equatable {
  public var id: Int?
  public var norm: String
  public var tokens: [String]
  public var lang: String?
  public var variantType: String?
}

/// An expression with its counting run.
public struct ResolvedExpression: Sendable, Equatable {
  public var id: Int
  public var surface: String
  public var norm: String
  public var kind: String
  public var lang: String?
  public var corpusID: Int?
  public var synthetic: Bool
  public var run: Int
  public var variants: [ResolvedVariant]
  /// The strand's languages; nil = any language.
  public var langs: [String]?
}

/// Expression resolution and the language rules.
public enum Expressions {
  static let latinLangs = ["en", "fr", "es", "de", "la", "it", "pt"]
  static let scriptLangs: [String: [String]] = ["Latn": latinLangs + ["und", "und-Latn"], "Deva": ["hi", "sa", "mr"], "Gujr": ["gu"]]

  /// `scriptOfTokens(tokens)` of server/text/variants.mjs.
  public static func scriptOfTokens(_ tokens: [String]) -> String {
    let text = tokens.joined()
    let scalars = text.unicodeScalars
    if scalars.contains(where: { (0x0A80...0x0AFF).contains($0.value) }) { return "Gujr" }
    if scalars.contains(where: { (0x0900...0x097F).contains($0.value) }) { return "Deva" }
    if scalars.contains(where: { TokenClassTable.classes($0.value).contains(.latin) }) { return "Latn" }
    if tokens.count == 1, let first = tokens[0].unicodeScalars.first {
      let c = TokenClassTable.classes(first.value)
      if c.contains(.otherSymbol) || c.contains(.number) { return "Symbol" }
    }
    return "Other"
  }

  /// `strandLanguages(expr, variants)`: the passage languages a strand counts in; nil = any language.
  public static func strandLanguages(exprLang: String?, variants: [ResolvedVariant]) -> [String]? {
    guard let exprLang, !exprLang.isEmpty else { return nil }
    var langs = JSSet()
    for v in variants {
      let script = scriptOfTokens(v.norm.components(separatedBy: " "))
      if v.variantType == "transliteration" {
        for l in scriptLangs[script] ?? ["und"] { langs.insert(l) }
        continue
      }
      let l = v.lang ?? exprLang
      if l.isEmpty { return nil }
      langs.insert(l)
      if script == "Latn" {
        langs.insert("und")
        langs.insert("und-Latn")
      } else if script != "Gujr" && script != "Deva" {
        langs.insert("und")
      }
    }
    if langs.isEmpty { langs.insert(exprLang) }
    return langs.sorted
  }

  /// `isUnidentified(lang)`: 'und', 'und-…', or none.
  public static func isUnidentified(_ lang: String?) -> Bool {
    guard let lang, !lang.isEmpty else { return true }
    return lang == "und" || lang.hasPrefix("und-")
  }

  /// `langAdmits(langs, plang, fieldClass, docLang)` (RF-1): whether a passage-level row counts in the strand's
  /// languages; an unidentified row of the document's own running text belongs to the document's text language.
  public static func langAdmits(_ langs: JSSet?, _ plang: String, _ fieldClass: String, _ docLang: String?) -> Bool {
    guard let langs else { return true }
    if !langs.contains(plang) { return false }
    if !isUnidentified(plang) || !["text", "abstract", "apparatus"].contains(fieldClass) { return true }
    return isUnidentified(docLang) || langs.contains(docLang!)
  }

  /// `resolveExpressions(db, ids, {pinned})`.
  public static func resolve(_ c: Connection, ids: [Int], pinned: AsSavedRuns?) throws -> [ResolvedExpression] {
    try ids.map { id in
      guard let e = try c.first(AnalysisSQL.expression, [.int(Int64(id))], { r in
        (id: r.i(0), surface: r.text(1), norm: r.text(2), kind: r.text(3), lang: r.textOrNil(4), corpus: r.iOrNil(5),
         syn: r.i(6) == 1)
      }) else { throw ScrollsError.notFound("Expression \(id)") }
      let pin = pinned?.pinned(id)
      if let pin, try c.first(AnalysisSQL.pinnedRun, [.int(Int64(pin)), .int(Int64(id))], { _ in true }) == nil {
        throw ScrollsError.badRequest(.validation, "Run \(pin) is not a succeeded materialization of expression \(id).",
                                      detail: ["field": "runs"])
      }
      var run = pin
      if run == nil { run = try c.first(AnalysisSQL.stateRun, [.int(Int64(id))]) { $0.iOrNil(0) } ?? nil }
      if run == nil { run = try c.first(AnalysisSQL.newestRun, [.int(Int64(id))]) { $0.i(0) } }
      guard let run else {
        let st = try c.first(AnalysisSQL.stateStatus, [.int(Int64(id))]) { $0.text(0) } ?? "none"
        throw ScrollsError(code: .notMaterialized, message: "Counting for '\(e.surface)' has not finished (state: \(st)).",
                           hint: "Compare is available once the expression is counted; the timeline shows the progress.",
                           detail: ["expr": .int(id), "status": .string(st)], status: 409)
      }
      let rows = try c.rows(AnalysisSQL.expressionVariants, [.int(Int64(id))]) { r in
        (id: Optional(r.i(0)), norm: r.text(1), lang: r.textOrNil(2), type: r.textOrNil(3))
      }
      let base = rows.isEmpty ? [(id: Int?.none, norm: e.norm, lang: e.lang, type: String?.none)] : rows
      let variants = base.map { v in
        ResolvedVariant(id: v.id, norm: v.norm, tokens: v.norm.components(separatedBy: " ").filter { !$0.isEmpty },
                        lang: v.lang ?? e.lang, variantType: v.type)
      }
      return ResolvedExpression(id: e.id, surface: e.surface, norm: e.norm, kind: e.kind, lang: e.lang, corpusID: e.corpus,
                                synthetic: e.syn, run: run, variants: variants,
                                langs: strandLanguages(exprLang: e.lang, variants: variants))
    }
  }
}
