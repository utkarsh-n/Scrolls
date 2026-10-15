// OWNER: Q (created by the bring-up, B2)
// The occurrence window and the embedding templates (IOS-SPEC-QWEN §2.2, §3.2; QWEN-LAB §4.1). The window is ±N engine
// words (tokenizer u61m-1, the engine's own) around the target's UTF-16 span, clipped to the passage and never across
// it; whitespace is collapsed as the lab's `window()` did (left stripped at its start, right at its end).

import Foundation
import ScrollsCore

public enum WindowRule: Codable, Sendable, Hashable {
  /// ±n engine words (u61m-1 tokens).
  case words(Int)
  /// ±n Qwen tokens (the lab's unit). Needs the Qwen tokenizer's offsets, which the pure layer does not have: at M1a
  /// it is not used, and `ContextWindow.make` treats it as the whole passage.
  case qwenTokens(Int)
  case passage

  public var key: String {
    switch self {
    case .words(let n): "w\(n)w"
    case .qwenTokens(let n): "w\(n)t"
    case .passage: "wp"
    }
  }
}

public struct ContextWindow: Sendable, Equatable {
  /// UTF-16 span of the match within the passage text.
  public var target: Range<Int>
  public var left: String
  public var mid: String
  public var right: String
  /// Engine words in the window outside the target, minus stop-words; < 8 is a thin window.
  public var contentTokens: Int
  public var wordsLeft: Int
  public var wordsRight: Int
  public var clippedLeft: Bool
  public var clippedRight: Bool

  public var isThin: Bool { contentTokens < 8 }
  public var text: String { left + mid + right }

  /// The window of `rule` around `target` (UTF-16 offsets into `passageText`).
  public static func make(passageText: String, target: Range<Int>, rule: WindowRule) -> ContextWindow {
    let units = Array(passageText.utf16)
    let lo = max(0, min(target.lowerBound, units.count))
    let hi = max(lo, min(target.upperBound, units.count))
    let tokens = ScrollsCore.Tokenizer.tokenize(passageText)
    let leftTokens = tokens.filter { $0.end <= lo }
    let rightTokens = tokens.filter { $0.start >= hi }
    var a = 0, b = units.count
    var nl = leftTokens.count, nr = rightTokens.count
    if case .words(let n) = rule {
      if leftTokens.count > n { a = leftTokens[leftTokens.count - n].start; nl = n }
      if rightTokens.count > n { b = rightTokens[n - 1].end; nr = n }
    }
    func s(_ x: Int, _ y: Int) -> String { String(decoding: units[x..<y], as: UTF16.self) }
    let left = collapse(s(a, lo)).trimmingLeadingWhitespace()
    let right = collapse(s(hi, b)).trimmingTrailingWhitespace()
    let inWindow = leftTokens.suffix(nl) + rightTokens.prefix(nr)
    let content = inWindow.filter { !Stopwords.english.contains($0.norm) }.count
    return ContextWindow(target: lo..<hi, left: left, mid: s(lo, hi), right: right, contentTokens: content,
                         wordsLeft: nl, wordsRight: nr, clippedLeft: a > 0, clippedRight: b < units.count)
  }

  /// Runs of whitespace become one space (the lab's `re.sub(r'\s+', ' ', …)`).
  static func collapse(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.utf8.count)
    var inSpace = false
    for ch in s.unicodeScalars {
      if CharacterSet.whitespacesAndNewlines.contains(ch) {
        if !inSpace { out.unicodeScalars.append(" ") }
        inSpace = true
      } else {
        out.unicodeScalars.append(ch)
        inSpace = false
      }
    }
    return out
  }
}

extension String {
  func trimmingLeadingWhitespace() -> String {
    String(unicodeScalars.drop(while: { CharacterSet.whitespacesAndNewlines.contains($0) }))
  }
  func trimmingTrailingWhitespace() -> String {
    var scalars = Array(unicodeScalars)
    while let last = scalars.last, CharacterSet.whitespacesAndNewlines.contains(last) { scalars.removeLast() }
    var s = ""
    s.unicodeScalars.append(contentsOf: scalars)
    return s
  }
}

public enum EmbeddingTemplate: String, Codable, Sendable {
  /// R1: "Instruct: Represent the meaning of the <word|expression> '<w>' in this passage\nQuery: <left><mid><right>"
  case occInstr1 = "occ-instr@1"
  /// The document side of retrieval: the window text alone.
  case doc1 = "doc@1"
  /// The question side of retrieval.
  case query1 = "query@1"

  public func render(_ w: ContextWindow, expression: String) -> String {
    switch self {
    case .occInstr1:
      let kind = expression.contains(" ") ? "expression" : "word"
      return "Instruct: Represent the meaning of the \(kind) '\(expression)' in this passage\nQuery: \(w.text)"
    case .doc1, .query1:
      return w.text
    }
  }

  public static func renderQuery(_ question: String) -> String {
    "Instruct: Given a question, retrieve passages that answer the question\nQuery: \(question)"
  }
}

/// One rendered embedding input and how it was fitted under the token cap.
public struct EmbeddingInput: Codable, Sendable, Equatable {
  public var id: String
  public var input: String
  /// Words each side actually used (≤ the rule's n once the cap shrank it).
  public var words: Int
  public var thin: Bool

  public init(id: String, input: String, words: Int, thin: Bool) {
    self.id = id
    self.input = input
    self.words = words
    self.thin = thin
  }

  /// The R1 input for one occurrence, shrunk symmetrically one word per side at a time until `count(input) + 1`
  /// (the appended <|endoftext|>) fits `maxTokens`. `count` is the Qwen tokenizer's count without special tokens.
  public static func fit(id: String, passageText: String, target: Range<Int>, expression: String, words: Int = 24,
                         maxTokens: Int = 128, template: EmbeddingTemplate = .occInstr1,
                         count: (String) -> Int) -> EmbeddingInput {
    var n = words
    var w = ContextWindow.make(passageText: passageText, target: target, rule: .words(n))
    var input = template.render(w, expression: expression)
    while n > 0 && count(input) + 1 > maxTokens {
      n -= 1
      w = ContextWindow.make(passageText: passageText, target: target, rule: .words(n))
      input = template.render(w, expression: expression)
    }
    return EmbeddingInput(id: id, input: input, words: n, thin: w.isThin)
  }
}

/// The representation key (IOS-SPEC-QWEN §2.2): "qe06-q8@fe956e8d/occ-instr@1/w24w/d256".
public struct RepresentationKey: Codable, Sendable, Hashable, CustomStringConvertible {
  public var model: String
  public var sha8: String
  public var template: String
  public var window: WindowRule
  public var dims: Int

  public init(model: String, sha8: String, template: String, window: WindowRule, dims: Int) {
    self.model = model
    self.sha8 = sha8
    self.template = template
    self.window = window
    self.dims = dims
  }

  public static let r1 = RepresentationKey(model: "qe06-q8", sha8: ModelCatalog.embedder.sha8, template: EmbeddingTemplate.occInstr1.rawValue,
                                           window: .words(24), dims: 256)

  public var description: String { "\(model)@\(sha8)/\(template)/\(window.key)/d\(dims)" }

  public init?(_ string: String) {
    let parts = string.split(separator: "/").map(String.init)
    guard parts.count == 4 else { return nil }
    let head = parts[0].split(separator: "@").map(String.init)
    guard head.count == 2, parts[3].hasPrefix("d"), let d = Int(parts[3].dropFirst()) else { return nil }
    let w = parts[2]
    let window: WindowRule
    if w == "wp" {
      window = .passage
    } else if w.hasPrefix("w"), w.hasSuffix("w"), let n = Int(w.dropFirst().dropLast()) {
      window = .words(n)
    } else if w.hasPrefix("w"), w.hasSuffix("t"), let n = Int(w.dropFirst().dropLast()) {
      window = .qwenTokens(n)
    } else {
      return nil
    }
    self.init(model: head[0], sha8: head[1], template: parts[1], window: window, dims: d)
  }
}
