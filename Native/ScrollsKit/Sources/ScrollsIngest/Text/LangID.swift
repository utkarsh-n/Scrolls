// OWNER: N1
// Port of server/text/langid.mjs and its stop-word lists (Resources/stopwords, copied verbatim): language identification
// per passage and per document (SPEC §4.3, §5.6).
//
// Script first: Gujarati → gu; Devanagari → hi (or the declared sa/mr; confidence 0.6 when undeclared). Latin script:
// stop-word profiles (first 60 words of stopwords/<lang>.json) for en/fr/es/de/la/it/pt; a language wins when its hits
// per token are ≥ 0.15 and ≥ 1.5 × the runner-up over ≥ 8 tokens, else 'und'; Latin texts under 8 tokens are 'und-Latn'.
// Confidences are heuristic scores in [0, 1], not probabilities. Rounding is JavaScript's (`JSNumber.round`), sorts are
// stable as Array.prototype.sort, and object key order is insertion order, as the reference's results depend on them.

import Foundation
import ScrollsCore

/// A passage's language, its confidence and the Latin profile scores.
public struct LangGuess: Sendable, Equatable {
  public var lang: String
  public var confidence: Double
  /// Hits per token for each Latin profile language, in `LangID.profileLangs` order (empty off Latin script).
  public var scores: [(lang: String, score: Double)]

  public init(lang: String, confidence: Double, scores: [(lang: String, score: Double)]) {
    self.lang = lang
    self.confidence = confidence
    self.scores = scores
  }

  public static func == (a: LangGuess, b: LangGuess) -> Bool {
    a.lang == b.lang && a.confidence == b.confidence && a.scores.count == b.scores.count
      && zip(a.scores, b.scores).allSatisfy { $0.lang == $1.lang && $0.score == $1.score }
  }
}

/// A document's language from its passages (`documentLang`).
public struct DocumentLanguage: Sendable, Equatable {
  public var langText: String
  public var confidence: Double
  public var isTranslation: Bool
  public var share: Double
  /// Token share per passage language, ranked (the reference's `by_lang` object, in its key order).
  public var byLang: [(lang: String, share: Double)]

  public init(langText: String, confidence: Double, isTranslation: Bool, share: Double, byLang: [(lang: String, share: Double)]) {
    self.langText = langText
    self.confidence = confidence
    self.isTranslation = isTranslation
    self.share = share
    self.byLang = byLang
  }

  public static func == (a: DocumentLanguage, b: DocumentLanguage) -> Bool {
    a.langText == b.langText && a.confidence == b.confidence && a.isTranslation == b.isTranslation && a.share == b.share
      && a.byLang.count == b.byLang.count && zip(a.byLang, b.byLang).allSatisfy { $0.lang == $1.lang && $0.share == $1.share }
  }
}

/// Language identification (langid.mjs).
public enum LangID {
  /// Languages with a Latin-script stop-word profile.
  public static let profileLangs = ["en", "fr", "es", "de", "la", "it", "pt"]
  /// Every stop-word list in the bundle.
  public static let stopwordLangs = profileLangs + ["hi", "gu"]

  static let minTokens = 8
  static let minScore = 0.15
  static let minRatio = 1.5
  static let translationShare = 0.7
  static let translationConfidence = 0.6
  /// Fewest identified tokens behind a translation claim (a title of a few words is no evidence of a language).
  public static let translationMinTokens = 20

  /// The folded stop-word list of a language (all words, most frequent first).
  public static func stopwords(_ lang: String) -> [String] { lists[lang] ?? [] }

  private static let lists: [String: [String]] = {
    var out: [String: [String]] = [:]
    for lang in stopwordLangs {
      guard let url = Bundle.module.url(forResource: lang, withExtension: "json", subdirectory: "stopwords")
        ?? Bundle.module.url(forResource: "stopwords/\(lang)", withExtension: "json"),
        let data = try? Data(contentsOf: url), let v = try? JSONValue.parse(data),
        let words = v["words"]?.arrayValue
      else { continue }
      out[lang] = words.compactMap(\.stringValue)
    }
    return out
  }()

  /// word → the profile languages whose 60-word profile contains it, in profile order.
  private static let profileIndex: [String: [Int]] = {
    var m: [String: [Int]] = [:]
    for (k, lang) in profileLangs.enumerated() {
      for w in stopwords(lang).prefix(60) { m[w, default: []].append(k) }
    }
    return m
  }()

  /// Whether the stop-word lists loaded (a missing bundle resource would make every Latin text 'und').
  public static var isLoaded: Bool { stopwordLangs.allSatisfy { !(lists[$0] ?? []).isEmpty } }

  /// Script of one code point by block (fast path for the scripts identified); nil for non-letters.
  @inline(__always)
  static func scriptOfCode(_ c: UInt32) -> UInt8? {
    if c < 0x80 { return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) ? 0 : nil }
    if (c >= 0xC0 && c <= 0x24F && c != 0xD7 && c != 0xF7) || (c >= 0x1E00 && c <= 0x1EFF) { return 0 }
    if c >= 0x0900 && c <= 0x097F { return c >= 0x0964 && c <= 0x096F ? nil : 1 }  // dandas and digits are not letters
    if c >= 0x0A80 && c <= 0x0AFF { return c >= 0x0AE6 && c <= 0x0AEF ? nil : 2 }
    return TokenClassTable.classes(c).contains(.letter) ? 3 : nil
  }

  static let scriptNames = ["Latn", "Deva", "Gujr", "Other"]

  /// The dominant script among the letters of a text ('Latn' | 'Deva' | 'Gujr' | 'Other'): a script needs more than
  /// half of the letters, else 'Other'.
  public static func scriptOf(_ text: String) -> String {
    scriptOf(units: Array(text.utf16)[...])
  }

  /// `scriptOf` over code units (a passage slice).
  public static func scriptOf(units u: ArraySlice<UInt16>) -> String {
    var counts = [0, 0, 0, 0]
    var letters = 0
    var i = u.startIndex
    while i < u.endIndex {
      var cp = UInt32(u[i])
      var len = 1
      if u[i] >= 0xD800, u[i] <= 0xDBFF, i + 1 < u.endIndex, u[i + 1] >= 0xDC00, u[i + 1] <= 0xDFFF {
        cp = 0x10000 + (UInt32(u[i] - 0xD800) << 10) + UInt32(u[i + 1] - 0xDC00)
        len = 2
      }
      i += len
      guard let sc = scriptOfCode(cp) else { continue }
      letters += 1
      counts[Int(sc)] += 1
    }
    if letters == 0 { return "Other" }
    var best = 3
    for k in 0..<4 where counts[k] > counts[best] { best = k }
    return counts[best] * 2 > letters ? scriptNames[best] : "Other"
  }

  /// Stop-word scores (hits per token, rounded to 3 decimals) of folded tokens against the Latin profiles.
  public static func profileScores(_ tokens: [String]) -> [(lang: String, score: Double)] {
    var hits = [Int](repeating: 0, count: profileLangs.count)
    for t in tokens {
      for k in profileIndex[t] ?? [] { hits[k] += 1 }
    }
    let n = Double(tokens.isEmpty ? 1 : tokens.count)
    return profileLangs.enumerated().map { ($0.element, JSNumber.round((Double(hits[$0.offset]) / n) * 1000) / 1000) }
  }

  /// Language of already-tokenized text (the writer tokenizes once and reuses the tokens).
  public static func detect(tokens: [String], declared: String?, script: String) -> LangGuess {
    let decl = declared.map { JSString.toLowerCase($0) }
    if script == "Gujr" { return LangGuess(lang: "gu", confidence: decl == "gu" ? 0.95 : 0.9, scores: []) }
    if script == "Deva" {
      if decl == "sa" || decl == "mr" { return LangGuess(lang: decl!, confidence: 0.8, scores: []) }
      return LangGuess(lang: "hi", confidence: decl == "hi" ? 0.9 : 0.6, scores: [])
    }
    if script != "Latn" { return LangGuess(lang: "und", confidence: 0, scores: []) }
    let scores = profileScores(tokens)
    if tokens.count < minTokens { return LangGuess(lang: "und-Latn", confidence: 0, scores: scores) }
    // stable descending sort by score, as Array.prototype.sort
    let ranked = scores.enumerated().sorted { $0.element.score != $1.element.score ? $0.element.score > $1.element.score : $0.offset < $1.offset }
      .map(\.element)
    let (best, s1) = ranked[0], s2 = ranked[1].score
    if s1 < minScore || s1 < minRatio * s2 { return LangGuess(lang: "und", confidence: 0, scores: scores) }
    // separation from the runner-up, discounted for short texts
    let separation = 1 - s2 / s1
    let length = min(1, 0.7 + Double(tokens.count) / 100)
    let confidence = JSNumber.round(min(0.99, (0.5 + 0.5 * separation) * length) * 100) / 100
    return LangGuess(lang: best, confidence: confidence, scores: scores)
  }

  /// `detectLang(text, {declared})`.
  public static func detect(_ text: String, declared: String? = nil) -> LangGuess {
    detect(tokens: Tokenizer.tokens(text).tokens, declared: declared, script: scriptOf(text))
  }

  static func isUnd(_ lang: String) -> Bool { lang.isEmpty || lang == "und" || lang.hasPrefix("und-") }

  static func primary(_ lang: String?) -> String {
    let s = JSString.toLowerCase(lang ?? "")
    return JSString.split(s, "-")[0]
  }

  /// Document language = token-weighted majority of its passages' languages (§5.6). `isTranslation` when a declared
  /// language differs from that majority, the majority covers ≥ 70% of the tokens, its confidence is ≥ 0.6 and it rests
  /// on ≥ 20 tokens (W_LANG_MISMATCH).
  public static func documentLang(_ passages: [(lang: String, tokens: Int, confidence: Double?)], declared: String?) -> DocumentLanguage {
    var order: [String] = []  // insertion order of the reference's byLang object
    var byLang: [String: Int] = [:]
    var confSum: [String: Double] = [:]
    var total = 0
    for p in passages {
      let n = max(0, Int(Int32(truncatingIfNeeded: p.tokens)))
      if n == 0 { continue }
      total += n
      if byLang[p.lang] == nil { order.append(p.lang) }
      byLang[p.lang, default: 0] += n
      confSum[p.lang, default: 0] += Double(n) * (p.confidence ?? 0)
    }
    if total == 0 { return DocumentLanguage(langText: "und", confidence: 0, isTranslation: false, share: 0, byLang: []) }
    let ranked = order.enumerated().sorted {
      let a = byLang[$0.element]!, b = byLang[$1.element]!
      return a != b ? a > b : $0.offset < $1.offset
    }.map { (lang: $0.element, n: byLang[$0.element]!) }
    let detected = ranked.filter { !isUnd($0.lang) }
    let (lang, n) = detected.first ?? ranked[0]
    let share = Double(n) / Double(total)
    let confidence = isUnd(lang) ? 0 : JSNumber.round((confSum[lang]! / Double(n)) * 100) / 100
    let isTranslation = (declared.map { !$0.isEmpty } ?? false) && !isUnd(lang) && primary(declared) != primary(lang)
      && share >= translationShare && confidence >= translationConfidence && n >= translationMinTokens
    return DocumentLanguage(langText: lang, confidence: confidence, isTranslation: isTranslation,
                            share: JSNumber.round(share * 1000) / 1000,
                            byLang: ranked.map { ($0.lang, JSNumber.round((Double($0.n) / Double(total)) * 1000) / 1000) })
  }
}
