// OWNER: N3
// Port of server/text/translit.mjs (SPEC §4.5): transliteration keys for Devanagari/Gujarati ↔ Latin, off by default.
// romanKey() maps a Devanagari or Gujarati word to a loose Latin skeleton (ISO-15919-lite) and folds Latin words with the
// same rules; two words match when their keys are equal and at least 4 characters long ("Shunya" ↔ शून्य). Matches are
// offered as `transliteration` variants — real forms found in the corpus vocabulary, each with its own count and toggle,
// never silently merged. G1 family g1.translit.

import Foundation
import ScrollsCore
import ScrollsStore

/// Transliteration keys and vocabulary candidates.
public enum Translit {
  /// Rule id of transliteration variants.
  public static let rule = "translit-key@1"
  /// Shortest key that may match.
  public static let minKey = 4
  static let groupVersion = 1

  // Devanagari and Gujarati share one table: the Gujarati block is the Devanagari block + 0x180.
  static let consonantPairs: [(UInt32, String)] = [
    (0x915, "k"), (0x916, "k"), (0x917, "g"), (0x918, "g"), (0x919, "n"), (0x91A, "c"), (0x91B, "c"), (0x91C, "j"),
    (0x91D, "j"), (0x91E, "n"), (0x91F, "t"), (0x920, "t"), (0x921, "d"), (0x922, "d"), (0x923, "n"), (0x924, "t"),
    (0x925, "t"), (0x926, "d"), (0x927, "d"), (0x928, "n"), (0x92A, "p"), (0x92B, "p"), (0x92C, "b"), (0x92D, "b"),
    (0x92E, "m"), (0x92F, "y"), (0x930, "r"), (0x932, "l"), (0x933, "l"), (0x935, "v"), (0x936, "s"), (0x937, "s"),
    (0x938, "s"), (0x939, "h"),
  ]
  static let vowelPairs: [(UInt32, String)] = [
    (0x905, "a"), (0x906, "a"), (0x907, "i"), (0x908, "i"), (0x909, "u"), (0x90A, "u"), (0x90B, "ri"), (0x90F, "e"),
    (0x910, "ai"), (0x913, "o"), (0x914, "au"), (0x90D, "e"), (0x911, "o"),
  ]
  static let consonants = Dictionary(uniqueKeysWithValues: consonantPairs)
  static let nuktaConsonants: [UInt32: String] = [0x915: "k", 0x916: "k", 0x917: "g", 0x91C: "j", 0x92B: "f", 0x921: "d", 0x922: "d"]
  static let vowels = Dictionary(uniqueKeysWithValues: vowelPairs)
  static let signs: [UInt32: String] = [0x93E: "a", 0x93F: "i", 0x940: "i", 0x941: "u", 0x942: "u", 0x943: "ri", 0x947: "e",
                                        0x948: "ai", 0x94B: "o", 0x94C: "au", 0x945: "e", 0x949: "o"]
  static let virama: UInt32 = 0x94D, nukta: UInt32 = 0x93C, anusvara: UInt32 = 0x902, candrabindu: UInt32 = 0x901,
    visarga: UInt32 = 0x903

  private struct Unit {
    var c: String
    var v: String
    var schwa = false
  }

  /// The units of a Devanagari/Gujarati word with schwa deletion (Ohala's rule, right to left).
  static func indicKey(_ word: String) -> String {
    let chars = JSText.codePoints(JSText.nfd(word)).map { $0 >= 0x0A80 && $0 <= 0x0AFF ? $0 - 0x180 : $0 }
    var units: [Unit] = []
    var i = 0
    while i < chars.count {
      let ch = chars[i]
      if let base = consonants[ch] {
        let hasNukta = i + 1 < chars.count && chars[i + 1] == nukta
        let c = hasNukta ? (nuktaConsonants[ch] ?? base) : base
        if hasNukta { i += 1 }
        let next: UInt32? = i + 1 < chars.count ? chars[i + 1] : nil
        if next == virama {
          units.append(Unit(c: c, v: ""))
          i += 1
        } else if let n = next, let s = signs[n] {
          units.append(Unit(c: c, v: s))
          i += 1
        } else {
          units.append(Unit(c: c, v: "a", schwa: true))
        }
      } else if let v = vowels[ch] {
        units.append(Unit(c: "", v: v))
      } else if let s = signs[ch] {
        units.append(Unit(c: "", v: s))
      } else if ch == anusvara || ch == candrabindu {
        units.append(Unit(c: "n", v: ""))
      } else if ch == visarga {
        units.append(Unit(c: "h", v: ""))
      }
      i += 1
    }
    var k = units.count - 1
    while k >= 0 {
      defer { k -= 1 }
      guard units[k].schwa else { continue }
      if k == units.count - 1 && k > 0 {
        units[k].v = ""
        continue
      }
      let prev: Unit? = k > 0 ? units[k - 1] : nil
      let next: Unit? = k + 1 < units.count ? units[k + 1] : nil
      if let p = prev, !p.v.isEmpty, let n = next, !n.c.isEmpty, !n.v.isEmpty { units[k].v = "" }
    }
    return units.map { $0.c + $0.v }.joined()
  }

  static func latinKey(_ word: String) -> String {
    let lowered = JSString.toLowerCase(JSText.removeMarks(JSText.nfd(word)))
    var s = String(lowered.unicodeScalars.filter { $0.value >= 0x61 && $0.value <= 0x7A }.map(Character.init))
    s = replaceAll(s, "sh", "s")
    s = dropAspirates(s)
    s = replaceAll(s, "w", "v")
    s = replaceAll(s, "z", "j")
    s = replaceAll(s, "q", "k")
    s = replaceAll(s, "x", "ks")
    s = replaceAll(s, "ee", "i")
    s = replaceAll(s, "oo", "u")
    s = squeezeAIU(s)
    return s
  }

  /// `s.replace(/x/g, y)` for a literal ASCII pattern, left to right without overlaps.
  private static func replaceAll(_ s: String, _ pattern: String, _ with: String) -> String {
    let u = Array(s.utf8), p = Array(pattern.utf8)
    var out: [UInt8] = []
    var i = 0
    while i < u.count {
      if i + p.count <= u.count && Array(u[i..<(i + p.count)]) == p {
        out += Array(with.utf8)
        i += p.count
      } else {
        out.append(u[i])
        i += 1
      }
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// `s.replace(/([kgcjtdpb])h/g, '$1')`.
  private static func dropAspirates(_ s: String) -> String {
    let stops = Set("kgcjtdpb".utf8)
    let u = Array(s.utf8)
    var out: [UInt8] = []
    var i = 0
    while i < u.count {
      out.append(u[i])
      if stops.contains(u[i]) && i + 1 < u.count && u[i + 1] == UInt8(ascii: "h") { i += 2 } else { i += 1 }
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// `s.replace(/([aiu])\1+/g, '$1')`.
  private static func squeezeAIU(_ s: String) -> String {
    let u = Array(s.utf8)
    var out: [UInt8] = []
    for b in u {
      if let last = out.last, last == b, b == UInt8(ascii: "a") || b == UInt8(ascii: "i") || b == UInt8(ascii: "u") { continue }
      out.append(b)
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// Whether a string holds a Devanagari or Gujarati code point.
  static func isIndic(_ s: String) -> Bool { JSText.anyInRanges(s, [0x0900...0x097F, 0x0A80...0x0AFF]) }

  /// `romanKey(word)`: a loose ISO-15919-lite Latin skeleton; a match needs equal keys and length ≥ 4.
  public static func romanKey(_ word: String) -> String {
    var key = isIndic(word) ? indicKey(word) : latinKey(word)
    key = squeezeAIU(key)
    if key.utf16.count > 1 && JSString.hasSuffix(key, "a") { key = JSText.slice(key, 0, -1) }
    return key
  }

  /// `translitMatch(a, b)`.
  public static func match(_ a: String, _ b: String) -> Bool {
    let ka = romanKey(a), kb = romanKey(b)
    return ka.utf16.count >= minKey && JSString.equal(ka, kb)
  }

  // MARK: vocabulary candidates

  /// Latin initials whose folded key starts with a given letter (w → v, z → j, q/x → k).
  static let latinInitials: [String: [String]] = ["v": ["v", "w"], "j": ["j", "z"], "k": ["k", "q", "x"]]

  /// Devanagari and Gujarati initials by the first letter of their key, in the reference's insertion order.
  static let indicInitials: [String: [String]] = {
    var by = OrderedDict<String, [String]>()
    func add(_ key: String, _ cp: UInt32) {
      let k = String(key.prefix(1))
      var list = by[k] ?? []
      list.append(String(Unicode.Scalar(cp)!))
      list.append(String(Unicode.Scalar(cp + 0x180)!))
      by[k] = list
    }
    for (cp, k) in consonantPairs { add(k, cp) }
    for (cp, k) in vowelPairs { add(k, cp) }
    var out: [String: [String]] = [:]
    for (k, v) in by.pairs { out[k] = v }
    return out
  }()

  /// One letter's group of the vocabulary: terms of the other script family with their keys and passage counts.
  public struct Group: Sendable, Codable {
    public var terms: [String] = []
    public var keys: [String] = []
    public var docs: [Int] = []
  }

  /// `scanGroup`: the vocabulary ranges of the initials that can produce `letter`.
  static func scanGroup(_ c: Connection, indicQuery: Bool, letter: String) throws -> Group {
    let top = String(Unicode.Scalar(0x10FFFF)!)
    let initials = indicQuery ? (latinInitials[letter] ?? [letter]) : (indicInitials[letter] ?? [])
    var g = Group()
    let s = try c.prepared(TextSQL.vocabRange)
    for ch in initials {
      try s.bind(.text(ch), .text(ch + top))
      while let r = try s.step() {
        let term = r.text(0)
        if indicQuery == isIndic(term) { continue }
        let k = romanKey(term)
        if k.utf16.count < minKey { continue }
        g.terms.append(term)
        g.keys.append(k)
        g.docs.append(Int(r.int(1)))
      }
    }
    return g
  }

  /// `vocabularyKey(db)`: import batches by status outside lexical collections, and the passage quality version.
  public static func vocabularyKey(_ c: Connection) throws -> String {
    var rows: [JSONValue] = []
    for r in try c.prepared(TextSQL.vocabBatches).all({ ($0.text(0), $0.int(1), $0.intOrNil(2)) }) {
      rows.append(.object(["status": .string(r.0), "n": .int(r.1), "m": .int(r.2)]))
    }
    let quality = try Meta.get(c, "quality_version") ?? "0"
    // JSON.stringify([GROUP_VERSION, batches, quality]) with each row's keys in SQL column order
    let text = OJ.arr([.int(groupVersion), .arr(rows.map { r in
      .obj([("status", OJ(r["status"]!)), ("n", OJ(r["n"]!)), ("m", OJ(r["m"]!))])
    }), .str(quality)]).stringify()
    return IDs.shortHash(text, length: 16)
  }

  /// A transliteration found in the vocabulary.
  public struct Candidate: Sendable, Equatable {
    public var form: String
    public var norm: String
    public var key: String
    public var passages: Int
  }

  /// `transliterationCandidates(db, surface, {limit})`: words of the other script family whose key equals the word's.
  public static func candidates(_ c: Connection, _ surface: String, limit: Int = 12) throws -> [Candidate] {
    let toks = Tokenizer.tokens(surface).tokens
    guard toks.count == 1 else { return [] }
    let word = toks[0]
    let key = romanKey(word)
    guard key.utf16.count >= minKey, let f = key.utf8.first, f >= 0x61, f <= 0x7A else { return [] }
    let indicQuery = isIndic(word)
    let letter = String(key.prefix(1))
    let g = try Artifacts.shared(c, name: "translit\(groupVersion)-\(indicQuery ? "latn" : "indic")-\(letter)",
                                 key: { try vocabularyKey($0) }) { try scanGroup($0, indicQuery: indicQuery, letter: letter) }
    var out = OrderedDict<JSKey, Candidate>()
    for i in g.keys.indices where JSString.equal(g.keys[i], key) {
      let t = g.terms[i]
      let norm = Fold.fold(t)
      let prev = out[JSKey(norm)]?.passages ?? 0
      out[JSKey(norm)] = Candidate(form: t, norm: norm, key: key, passages: prev + g.docs[i])
    }
    // a stable sort by passages, most first (Array.prototype.sort is stable)
    let sorted = out.values.enumerated().sorted { a, b in
      a.element.passages != b.element.passages ? a.element.passages > b.element.passages : a.offset < b.offset
    }.map(\.element)
    return Array(sorted.prefix(limit))
  }
}
