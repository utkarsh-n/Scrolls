// OWNER: Q (created by the bring-up, B2)
// The grounding verifier (IOS-SPEC-QWEN Q-08, §3.6; critique §2.2–§2.5). Nothing Qwen writes is shown before it has
// run. For a label: the citations must name passages that were given (the validator), and the gloss may not carry
// numbers or dates, change / cause / mental-state wording, or a capitalised name that none of the cited passages
// contains. A failing gloss is withheld and the label kept ("partly withheld"); a failing label refuses the reading.
// Quotes (Ask, M2) are matched verbatim against the passage and rendered from it, never from the model's bytes.

import Foundation
import ScrollsCore

public enum ReadingVerdict: String, Codable, Sendable { case shown, partlyWithheld, refused }

public struct VerifiedLabel: Codable, Sendable, Equatable {
  public var label: String?
  public var gloss: String?
  public var cites: [String]
  /// Why something was not shown, in words.
  public var withheld: [String]
  public var verdict: ReadingVerdict
}

public enum NumberGuard {
  static let numberWords: Set<String> = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty",
    "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "hundreds", "thousand", "thousands", "million",
    "millions", "billion", "century", "centuries", "decade", "decades", "first", "second", "third", "fourth", "fifth",
    "dozen", "half",
  ]

  /// The reasons `s` states a number or a date, in words; empty when it does not.
  public static func findings(_ s: String) -> [String] {
    var out: [String] = []
    if TextChecks.hasDigit(s) { out.append("states a number (digits)") }
    let hits = Verifier.tokens(s).filter { numberWords.contains($0) }
    if !hits.isEmpty { out.append("states a number or period (\(hits.joined(separator: ", ")))") }
    return out
  }
}

public enum ForbiddenWording {
  /// Change, cause and mental-state wording (critique §2.5): machine text never claims these.
  static let single: Set<String> = [
    "evolved", "evolve", "evolves", "evolution", "originally", "shifted", "shift", "shifts", "changed", "changing",
    "because", "caused", "causes", "thought", "believed", "believes", "felt", "feels", "wanted", "wants", "intended",
    "intends", "hoped", "hopes", "feared", "fears", "verified", "proves", "proved", "evidence", "first",
  ]
  static let phrases = ["came to mean", "led to", "due to", "used to mean", "no longer", "meant to"]

  public static func findings(_ s: String) -> [String] {
    let toks = Verifier.tokens(s)
    var hits = toks.filter { single.contains($0) }
    let lower = " " + toks.joined(separator: " ") + " "
    hits += phrases.filter { lower.contains(" \($0) ") }
    return hits.isEmpty ? [] : ["uses wording machine text may not use (\(hits.joined(separator: ", ")))"]
  }
}

public enum Verifier {
  static func tokens(_ s: String) -> [String] {
    Fold.fold(s).split(whereSeparator: { !($0.isLetter || $0 == "'") }).map(String.init)
  }

  /// Capitalised words after the first word of a sentence that none of `texts` contains (case-sensitive), so a
  /// gloss cannot introduce a name.
  public static func unsupportedNames(_ s: String, texts: [String]) -> [String] {
    var out: [String] = []
    var sentenceStart = true
    for raw in s.split(whereSeparator: { $0 == " " || $0 == "\n" }) {
      let word = raw.trimmingCharacters(in: CharacterSet.letters.inverted)
      defer { sentenceStart = raw.last.map { ".!?".contains($0) } ?? false }
      guard let first = word.unicodeScalars.first, CharacterSet.uppercaseLetters.contains(first), word != "I" else { continue }
      if sentenceStart { continue }
      if !texts.contains(where: { $0.contains(word) }) { out.append(word) }
    }
    return out
  }

  public static func verifyLabel(_ o: LabelOutput, passages: [PromptPassage]) -> VerifiedLabel {
    var withheld: [String] = []
    let labelProblems = NumberGuard.findings(o.label) + ForbiddenWording.findings(o.label)
      + unsupportedNames(o.label, texts: passages.map(\.text)).map { "names \($0), which no passage given contains" }
    if !labelProblems.isEmpty {
      return VerifiedLabel(label: nil, gloss: nil, cites: o.cites,
                           withheld: labelProblems.map { "label withheld: \($0)" }, verdict: .refused)
    }
    let cited = passages.filter { o.cites.contains($0.id) }.map(\.text)
    let glossProblems = NumberGuard.findings(o.gloss) + ForbiddenWording.findings(o.gloss)
      + unsupportedNames(o.gloss, texts: cited).map { "names \($0), which no cited passage contains" }
    var gloss: String? = o.gloss
    if !glossProblems.isEmpty {
      withheld = glossProblems.map { "description withheld: \($0)" }
      gloss = nil
    }
    return VerifiedLabel(label: o.label, gloss: gloss, cites: o.cites, withheld: withheld,
                         verdict: withheld.isEmpty ? .shown : .partlyWithheld)
  }
}

/// Verbatim quote matching (Ask, M2): whitespace runs and typographic quotes are normalised on both sides; the match
/// is case-sensitive and returns the UTF-16 range in the original passage, from which the quote is rendered.
public enum QuoteMatcher {
  static func normalise(_ c: Character) -> Character {
    switch c {
    case "\u{2018}", "\u{2019}": "'"
    case "\u{201C}", "\u{201D}": "\""
    default: c
    }
  }

  public static func match(_ quote: String, in passage: String) -> Range<Int>? {
    // normalised passage characters with their UTF-16 offsets
    var chars: [(Character, Int, Int)] = []
    var off = 0
    var lastSpace = false
    for ch in passage {
      let w = ch.utf16.count
      if ch.isWhitespace {
        if !lastSpace { chars.append((" ", off, off + w)) } else if let l = chars.last { chars[chars.count - 1] = (l.0, l.1, off + w) }
        lastSpace = true
      } else {
        chars.append((normalise(ch), off, off + w))
        lastSpace = false
      }
      off += w
    }
    var q: [Character] = []
    var qSpace = false
    for ch in quote.trimmingCharacters(in: .whitespacesAndNewlines) {
      if ch.isWhitespace { if !qSpace { q.append(" ") }; qSpace = true } else { q.append(normalise(ch)); qSpace = false }
    }
    guard !q.isEmpty, q.count <= chars.count else { return nil }
    outer: for i in 0...(chars.count - q.count) {
      for j in 0..<q.count where chars[i + j].0 != q[j] { continue outer }
      return chars[i].1..<chars[i + q.count - 1].2
    }
    return nil
  }
}
