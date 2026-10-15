// OWNER: N3
// Port of server/text/variants.mjs (SPEC §4.5): generated variants of an expression — en/fr/es inflection, hi
// oblique/plural, gu plural + attached postpositions, orthographic folds (Devanagari nukta, chandrabindu ↔ anusvara) and
// hyphenation. Every generated variant is evidence `computed`, carries its rule id and is shown with its own count and
// toggle. Pure functions over folded tokens; strings are compared and sliced by UTF-16 code units, as JavaScript does.
// G1 family g1.variants.

import ScrollsCore

/// One generated variant (the identity form is never included).
public struct GeneratedVariant: Sendable, Equatable {
  public var form: String
  public var norm: String
  public var tokens: [String]
  public var lang: String?
  public var type: String
  public var rule: String
  public var status: String
  public var enabled: Bool
}

/// The variant generator.
public enum Variants {
  /// Rule ids stored in `expression_variant.rule`.
  public enum Rule {
    public static let identity = "identity", en = "en-inflect@1", fr = "fr-inflect@1", es = "es-inflect@1",
      frFem = "fr-feminine@1", esFem = "es-feminine@1", hi = "hi-oblique@1", gu = "gu-postposition@1",
      nukta = "nukta-fold@1", candra = "candrabindu-anusvara@1", hyphen = "hyphen-join@1"
  }

  private struct Raw {
    var tokens: [String]
    var type: String
    var rule: String
    var enabled: Bool?
  }

  // MARK: scripts

  /// `scriptOfTokens`: 'Gujr', 'Deva', 'Latn', 'Symbol' for a lone symbol/number token, else 'Other'.
  public static func scriptOfTokens(_ tokens: [String]) -> String {
    let text = tokens.joined()
    if JSText.anyInRanges(text, [0x0A80...0x0AFF]) { return "Gujr" }
    if JSText.anyInRanges(text, [0x0900...0x097F]) { return "Deva" }
    if JSText.any(text, .latin) { return "Latn" }
    if tokens.count == 1 && JSText.startsWithClass(tokens[0], [.otherSymbol, .number]) { return "Symbol" }
    return "Other"
  }

  /// `kindOfTokens`: 'symbol' for a lone \p{So} token, 'word' for one token, else 'phrase'.
  public static func kindOfTokens(_ tokens: [String]) -> String {
    if tokens.count == 1 && JSText.startsWithClass(tokens[0], .otherSymbol) { return "symbol" }
    return tokens.count > 1 ? "phrase" : "word"
  }

  // MARK: English

  private static func isVowel(_ c: String) -> Bool { ["a", "e", "i", "o", "u"].contains { JSString.equal($0, c) } }
  private static func isLatinWord(_ w: String) -> Bool { JSText.all(w, .latin) }
  /// `w[w.length - k]`.
  private static func back(_ w: String, _ k: Int) -> String { JSText.charAt(w, w.utf16.count - k) }

  private static func doublesFinal(_ w: String) -> Bool {
    let n = w.utf16.count
    if n < 3 || n > 5 { return false }
    let last = back(w, 1), mid = back(w, 2), before = back(w, 3)
    if isVowel(last) || JSText.includes("wxy", last) || !isVowel(mid) || isVowel(before) { return false }
    var groups = 0, prev = false
    for u in w.utf16 {
      let v = isVowel(JSText.string([u]))
      if v && !prev { groups += 1 }
      prev = v
    }
    return groups == 1
  }

  private static func consonantY(_ w: String) -> Bool {
    w.utf16.count > 2 && JSString.hasSuffix(w, "y") && !isVowel(back(w, 2))
  }

  private static func sibilant(_ w: String) -> Bool { JSText.endsWithAny(w, ["s", "x", "z", "ch", "sh"]) }

  private static func enPlural(_ b: String) -> [String] {
    if consonantY(b) { return ["\(JSText.slice(b, 0, -1))ies"] }
    if sibilant(b) { return ["\(b)es"] }
    if b.utf16.count > 1 && JSString.hasSuffix(b, "o") && !isVowel(back(b, 2)) { return ["\(b)s", "\(b)es"] }
    return ["\(b)s"]
  }

  private static func enPast(_ b: String) -> String {
    if JSString.hasSuffix(b, "e") { return "\(b)d" }
    if consonantY(b) { return "\(JSText.slice(b, 0, -1))ied" }
    if doublesFinal(b) { return "\(b)\(back(b, 1))ed" }
    return "\(b)ed"
  }

  private static func enIng(_ b: String) -> String {
    if JSString.hasSuffix(b, "ie") { return "\(JSText.slice(b, 0, -2))ying" }
    if JSString.hasSuffix(b, "e") && !JSText.endsWithAny(b, ["ee", "ye", "oe"]) && b.utf16.count > 2 {
      return "\(JSText.slice(b, 0, -1))ing"
    }
    if doublesFinal(b) { return "\(b)\(back(b, 1))ing" }
    return "\(b)ing"
  }

  private static func enAgent(_ b: String) -> [String] {
    if JSText.endsWithAny(b, ["er", "or"]) { return [] }
    if JSString.hasSuffix(b, "e") { return ["\(b)r", "\(b)rs"] }
    if consonantY(b) { return ["\(JSText.slice(b, 0, -1))ier", "\(JSText.slice(b, 0, -1))iers"] }
    if doublesFinal(b) { return ["\(b)\(back(b, 1))er", "\(b)\(back(b, 1))ers"] }
    return ["\(b)er", "\(b)ers"]
  }

  private static func enBases(_ w: String) -> [String] {
    var bases = [w]
    let n = w.utf16.count
    if n > 4 && JSString.hasSuffix(w, "ies") { bases.append("\(JSText.slice(w, 0, -3))y") }
    else if n > 4 && JSText.endsWithAny(w, ["ses", "xes", "zes", "ches", "shes", "oes"]) { bases.append(JSText.slice(w, 0, -2)) }
    else if n > 3 && JSString.hasSuffix(w, "s") && !JSText.endsWithAny(w, ["ss", "us", "is"]) { bases.append(JSText.slice(w, 0, -1)) }
    return bases
  }

  private static func enWordForms(_ w: String) -> [Raw] {
    var out: [Raw] = []
    let bases = enBases(w)
    for b in bases.count > 1 ? Array(bases.dropFirst()) : bases {
      if !JSString.equal(b, w) { out.append(Raw(tokens: [b], type: "inflection", rule: Rule.en)) }
      for p in enPlural(b) { out.append(Raw(tokens: [p], type: "inflection", rule: Rule.en)) }
      out.append(Raw(tokens: [enPast(b)], type: "inflection", rule: Rule.en))
      out.append(Raw(tokens: [enIng(b)], type: "inflection", rule: Rule.en))
      for a in enAgent(b) { out.append(Raw(tokens: [a], type: "inflection", rule: Rule.en, enabled: false)) }
      out.append(Raw(tokens: [b, "s"], type: "inflection", rule: Rule.en))
    }
    return out
  }

  private static let enPhraseNext = JSStringSet(["the", "a", "an", "my", "your", "his", "her", "its", "our", "their", "this",
    "that", "it", "me", "him", "them", "us", "on", "off", "up", "out", "in", "to", "over", "away", "back", "down", "with", "for"])

  private static func enPhraseForms(_ tokens: [String]) -> [Raw] {
    let head = tokens[0]
    if !isLatinWord(head) || head.utf16.count < 2 || JSText.endsWithAny(head, ["ed", "ing", "s"])
      || !enPhraseNext.contains(tokens[1])
    {
      return []
    }
    let rest = Array(tokens.dropFirst())
    let heads = Array(enPlural(head).prefix(1)) + [enPast(head), enIng(head)]
    return heads.map { Raw(tokens: [$0] + rest, type: "inflection", rule: Rule.en) }
  }

  // MARK: French and Spanish

  private static func lastIn(_ w: String, _ set: String) -> Bool {
    guard let l = w.utf16.last else { return false }
    return set.utf16.contains(l)
  }

  private static func frWordForms(_ w: String) -> [Raw] {
    var out: [Raw] = []
    var bases = [w]
    if w.utf16.count > 3 && lastIn(w, "sx") { bases.append(JSText.slice(w, 0, -1)) }
    for b in bases {
      if !JSString.equal(b, w) { out.append(Raw(tokens: [b], type: "inflection", rule: Rule.fr)) }
      if JSText.endsWithAny(b, ["au", "eu"]) { out.append(Raw(tokens: ["\(b)x"], type: "inflection", rule: Rule.fr)) }
      else if JSString.hasSuffix(b, "al") { out.append(Raw(tokens: ["\(JSText.slice(b, 0, -2))aux"], type: "inflection", rule: Rule.fr)) }
      else if !lastIn(b, "sxz") { out.append(Raw(tokens: ["\(b)s"], type: "inflection", rule: Rule.fr)) }
      if !JSString.hasSuffix(b, "e") {
        out.append(Raw(tokens: ["\(b)e"], type: "inflection", rule: Rule.frFem, enabled: false))
        out.append(Raw(tokens: ["\(b)es"], type: "inflection", rule: Rule.frFem, enabled: false))
      }
    }
    return out
  }

  private static func esWordForms(_ w: String) -> [Raw] {
    var out: [Raw] = []
    var bases = [w]
    let n = w.utf16.count
    if n > 4 && JSString.hasSuffix(w, "es") { bases.append(JSText.slice(w, 0, -2)) }
    if n > 3 && JSString.hasSuffix(w, "s") { bases.append(JSText.slice(w, 0, -1)) }
    for b in bases {
      if !JSString.equal(b, w) { out.append(Raw(tokens: [b], type: "inflection", rule: Rule.es)) }
      if JSString.hasSuffix(b, "z") { out.append(Raw(tokens: ["\(JSText.slice(b, 0, -1))ces"], type: "inflection", rule: Rule.es)) }
      else if lastIn(b, "aeiou\u{E1}\u{E9}\u{ED}\u{F3}\u{FA}") { out.append(Raw(tokens: ["\(b)s"], type: "inflection", rule: Rule.es)) }
      else if !JSString.hasSuffix(b, "s") { out.append(Raw(tokens: ["\(b)es"], type: "inflection", rule: Rule.es)) }
      if JSString.hasSuffix(b, "o") {
        out.append(Raw(tokens: ["\(JSText.slice(b, 0, -1))a"], type: "inflection", rule: Rule.esFem, enabled: false))
        out.append(Raw(tokens: ["\(JSText.slice(b, 0, -1))as"], type: "inflection", rule: Rule.esFem, enabled: false))
      }
    }
    return out
  }

  // MARK: Hindi and Gujarati

  private static func lastCodePointIn(_ w: String, _ ranges: [ClosedRange<UInt32>]) -> Bool {
    guard let l = w.unicodeScalars.last else { return false }
    return JSText.inRanges(l.value, ranges)
  }

  private static func hiWordForms(_ w: String) -> [Raw] {
    var out: [Raw] = []
    func add(_ form: String) { out.append(Raw(tokens: [form], type: "inflection", rule: Rule.hi)) }
    if JSString.hasSuffix(w, "\u{93E}") {
      let stem = JSText.slice(w, 0, -1)
      add("\(stem)\u{947}"); add("\(stem)\u{94B}\u{902}"); add("\(w)\u{913}\u{902}")
    } else if JSString.hasSuffix(w, "\u{940}") {
      let stem = JSText.slice(w, 0, -1)
      add("\(stem)\u{93F}\u{92F}\u{93E}\u{901}"); add("\(stem)\u{93F}\u{92F}\u{94B}\u{902}")
    } else if lastCodePointIn(w, [0x0915...0x0939, 0x0958...0x095F]) || JSString.hasSuffix(w, "\u{93C}") {
      add("\(w)\u{94B}\u{902}"); add("\(w)\u{947}\u{902}"); add("\(w)\u{93E}\u{90F}\u{901}")
    }
    return out
  }

  private static let guPostpositions = ["\u{AA8}\u{ACB}", "\u{AA8}\u{AC0}", "\u{AA8}\u{ABE}", "\u{AA8}\u{AC7}",
                                        "\u{AAE}\u{ABE}\u{A82}", "\u{AA5}\u{AC0}", "\u{A8F}"]

  private static func guWordForms(_ w: String) -> [Raw] {
    var out: [Raw] = []
    func add(_ form: String) { out.append(Raw(tokens: [form], type: "inflection", rule: Rule.gu)) }
    let plurals = lastCodePointIn(w, [0x0A95...0x0AB9]) ? ["\(w)\u{ACB}", "\(w)\u{A93}"] : ["\(w)\u{A93}"]
    for p in plurals { add(p) }
    for base in [w] + plurals { for pp in guPostpositions { add("\(base)\(pp)") } }
    return out
  }

  // MARK: orthographic folds (hi/gu)

  private static let nukta: UInt32 = 0x093C
  private static let nuktaFoldable: Set<UInt32> = [0x0915, 0x0916, 0x0917, 0x091C, 0x092B]
  private static let toAnusvara: [UInt32: UInt32] = [0x0901: 0x0902, 0x0A81: 0x0A82]
  private static let toCandra: [UInt32: UInt32] = [0x0902: 0x0901, 0x0A82: 0x0A81]

  private static func fromCodePoints(_ cps: [UInt32]) -> String {
    var v = String.UnicodeScalarView()
    for c in cps { if let s = Unicode.Scalar(c) { v.append(s) } }
    return String(v)
  }

  /// Forms of one token with every foldable nukta removed and every combination of nuktas added (≤ 3 sites), in
  /// insertion order of the reference's Set.
  private static func nuktaForms(_ t: String) -> [String] {
    let chars = JSText.codePoints(t)
    var out = OrderedDict<JSKey, String>()
    var stripped: [UInt32] = []
    for i in chars.indices {
      if chars[i] == nukta && i > 0 && nuktaFoldable.contains(chars[i - 1]) { continue }
      stripped.append(chars[i])
    }
    let base = fromCodePoints(stripped)
    if !JSString.equal(base, t) { out[JSKey(base)] = base }
    var sites: [Int] = []
    for (i, ch) in stripped.enumerated() where nuktaFoldable.contains(ch) && (i + 1 >= stripped.count || stripped[i + 1] != nukta) {
      sites.append(i)
    }
    let n = min(sites.count, 3)
    if n > 0 {
      for mask in 1..<(1 << n) {
        var arr = stripped
        for b in stride(from: n - 1, through: 0, by: -1) where mask & (1 << b) != 0 { arr.insert(nukta, at: sites[b] + 1) }
        let s = fromCodePoints(arr)
        if out[JSKey(s)] == nil { out[JSKey(s)] = s }
      }
    }
    out[JSKey(t)] = nil
    return out.values
  }

  private static func nuktaFolded(_ t: String) -> [String] {
    let chars = JSText.codePoints(t)
    var kept: [UInt32] = []
    for i in chars.indices where !(chars[i] == nukta && i > 0 && nuktaFoldable.contains(chars[i - 1])) { kept.append(chars[i]) }
    let out = fromCodePoints(kept)
    return JSString.equal(out, t) ? [] : [out]
  }

  private static func candraForms(_ t: String) -> [String] {
    let cps = JSText.codePoints(t)
    guard cps.contains(where: { [0x0901, 0x0902, 0x0A81, 0x0A82].contains($0) }) else { return [] }
    let a = fromCodePoints(cps.map { toAnusvara[$0] ?? $0 })
    let c = fromCodePoints(cps.map { toCandra[$0] ?? $0 })
    var out: [String] = []
    for x in [a, c] where !out.contains(where: { JSString.equal($0, x) }) { out.append(x) }
    return out.filter { !JSString.equal($0, t) }
  }

  private static func orthographicForms(_ tokens: [String], typed: Bool) -> [Raw] {
    var out: [Raw] = []
    for (i, t) in tokens.enumerated() {
      func swap(_ f: String) -> [String] { tokens.enumerated().map { $0.offset == i ? f : $0.element } }
      for f in typed ? nuktaForms(t) : nuktaFolded(t) { out.append(Raw(tokens: swap(f), type: "spelling", rule: Rule.nukta)) }
      for f in candraForms(t) { out.append(Raw(tokens: swap(f), type: "spelling", rule: Rule.candra)) }
    }
    return out
  }

  // MARK: entry point

  /// `generateVariants(surface, {lang, kinds})`.
  public static func generate(_ surface: String, lang: String? = nil, kinds: [String]? = nil) -> [GeneratedVariant] {
    let tokens = Tokenizer.tokens(surface).tokens
    if tokens.isEmpty { return [] }
    let script = scriptOfTokens(tokens)
    let l: String?
    if let lang, !lang.isEmpty {
      l = JSString.split(JSString.toLowerCase(lang), "-")[0]
    } else {
      l = script == "Deva" ? "hi" : script == "Gujr" ? "gu" : nil
    }
    var raw: [Raw] = []
    if tokens.count == 1 {
      let w = tokens[0]
      if l == "en" && isLatinWord(w) { raw += enWordForms(w) }
      else if l == "fr" && isLatinWord(w) { raw += frWordForms(w) }
      else if l == "es" && isLatinWord(w) { raw += esWordForms(w) }
      else if l == "hi" && script == "Deva" { raw += hiWordForms(w) }
      else if l == "gu" && script == "Gujr" { raw += guWordForms(w) }
    } else if l == "en" {
      raw += enPhraseForms(tokens)
    }
    if script == "Deva" || script == "Gujr" {
      let inflected = script == "Deva" ? raw : []
      raw += orthographicForms(tokens, typed: true)
      for f in inflected {
        for var o in orthographicForms(f.tokens, typed: false) {
          o.enabled = f.enabled ?? true
          raw.append(o)
        }
      }
    }
    if tokens.count == 2 && hasLetterHyphenLetter(surface) {
      raw.append(Raw(tokens: [tokens.joined()], type: "hyphenation", rule: Rule.hyphen))
    }

    var seen = JSStringSet([tokens.joined(separator: " ")])
    var out: [GeneratedVariant] = []
    for r in raw {
      if let kinds, !kinds.contains(r.type) { continue }
      let norm = r.tokens.joined(separator: " ")
      if seen.contains(norm) || r.tokens.contains(where: { $0.isEmpty }) { continue }
      seen.insert(norm)
      out.append(GeneratedVariant(form: displayForm(surface, tokens, r.tokens), norm: norm, tokens: r.tokens, lang: l,
                                  type: r.type, rule: r.rule, status: "computed", enabled: r.enabled ?? true))
    }
    return out
  }

  /// `/\p{L}[-‐‑–]\p{L}/u.test(surface)`.
  private static func hasLetterHyphenLetter(_ s: String) -> Bool {
    let cps = JSText.codePoints(s)
    guard cps.count >= 3 else { return false }
    for i in 1..<(cps.count - 1) where [0x2D, 0x2010, 0x2011, 0x2013].contains(cps[i]) {
      if JSText.classes(cps[i - 1]).contains(.letter) && JSText.classes(cps[i + 1]).contains(.letter) { return true }
    }
    return false
  }

  private static func displayForm(_ surface: String, _ tokens: [String], _ vtokens: [String]) -> String {
    if vtokens.count == tokens.count + 1 && JSString.equal(vtokens[vtokens.count - 1], "s") && tokens.count == 1 {
      return "\(vtokens[0])'s"
    }
    return vtokens.joined(separator: " ")
  }

  /// `variantsHash(variants)`: shortHash(canonicalJson(sorted `lang\0norm` of the enabled variants), 16).
  public static func variantsHash(_ variants: [(norm: String, lang: String?, enabled: Bool)]) -> String {
    let enabled = variants.filter(\.enabled).map { "\($0.lang ?? "")\u{0}\($0.norm)" }.sorted(by: CanonicalJSON.codeUnitLess)
    return IDs.shortHash(CanonicalJSON.string(.array(enabled.map(JSONValue.string))), length: 16)
  }
}
