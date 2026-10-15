// OWNER: Q (created by the bring-up, B2)
// Prompts are data (IOS-SPEC-QWEN §2.4): Resources/prompts/<task>@<n>.{system,user}.txt, their sha256 recorded on
// every run; a change is a new version, never an edit. `label@1` is the lab's measured V1 prompt (QWEN-LAB §4.3) with
// `description` renamed `gloss` and a `cites` field; passages carry a period slot, the source and the title, never a
// date. The chat template is Qwen3-2507's non-thinking ChatML, rendered here (no Jinja on the phone).

import Foundation
import ScrollsCore

public struct PromptPassage: Codable, Sendable, Equatable {
  /// "P1" …
  public var id: String
  /// "{A}", "{B}" … in date order; "{U}" undated.
  public var slot: String
  public var source: String
  public var title: String?
  /// The ±25-word excerpt shown to the model, with "… " / " …" where it was cut.
  public var text: String

  public init(id: String, slot: String, source: String, title: String?, text: String) {
    self.id = id
    self.slot = slot
    self.source = source
    self.title = title
    self.text = text
  }
}

public struct RenderedPrompt: Sendable, Equatable {
  public var promptID: String
  public var system: String
  public var user: String
  /// sha256 of the two template files as stored (system + "\u{0}" + user).
  public var promptSHA256: String
}

public enum PromptLibrary {
  public static let labelID = "label@1"

  static func resource(_ name: String) -> String {
    guard let url = Bundle.module.url(forResource: name, withExtension: "txt", subdirectory: "prompts"),
          let s = try? String(contentsOf: url, encoding: .utf8) else {
      preconditionFailure("ScrollsQwen resource prompts/\(name).txt is missing from the bundle")
    }
    return s.hasSuffix("\n") ? String(s.dropLast()) : s
  }

  public static var labelSystem: String { resource("label@1.system") }
  public static var labelUser: String { resource("label@1.user") }

  public static let numberWords = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]

  /// The `label@1` prompt for one group.
  public static func label(word: String, computedWords: [String], passages: [PromptPassage]) -> RenderedPrompt {
    let system = labelSystem
    let template = labelUser
    let lines = passages.map { p -> String in
      var head = "period \(p.slot); \(p.source)"
      if let t = p.title, !t.isEmpty { head += "; title: \(t)" }
      return "[\(p.id)] (\(head)) \(p.text)"
    }
    let count = passages.count < numberWords.count ? numberWords[passages.count] : String(passages.count)
    let user = template
      .replacingOccurrences(of: "{{word}}", with: word)
      .replacingOccurrences(of: "{{words}}", with: computedWords.isEmpty ? "(none passed the test)" : computedWords.joined(separator: ", "))
      .replacingOccurrences(of: "{{count}}", with: count)
      .replacingOccurrences(of: "{{passages}}", with: lines.joined(separator: "\n"))
    return RenderedPrompt(promptID: labelID, system: system, user: user,
                          promptSHA256: IDs.sha256Hex(system + "\u{0}" + template))
  }

  /// Period slots in date order: equal years share a slot; undated is {U}. Returns one slot per input, in order.
  public static func slots(years: [Int?]) -> [String] {
    let distinct = Array(Set(years.compactMap { $0 })).sorted()
    let letters = Array("ABCDEFGHIJKLMNOPQRST")
    return years.map { y in
      guard let y, let i = distinct.firstIndex(of: y) else { return "{U}" }
      return "{\(i < letters.count ? String(letters[i]) : "Z")}"
    }
  }
}

/// Qwen3-2507 (non-thinking) ChatML.
public enum QwenChat {
  public static let imStart = "<|im_start|>"
  public static let imEnd = "<|im_end|>"
  public static let endOfText = "<|endoftext|>"
  public static let endOfTextID = 151_643
  public static let imEndID = 151_645

  public static func render(system: String, user: String) -> String {
    "\(imStart)system\n\(system)\(imEnd)\n\(imStart)user\n\(user)\(imEnd)\n\(imStart)assistant\n"
  }
}

/// Excerpts for prompts and cards: ±n engine words around the match, "… " / " …" where cut, whitespace collapsed.
public enum Excerpt {
  public static func around(_ text: String, target: Range<Int>, words: Int) -> String {
    let w = ContextWindow.make(passageText: text, target: target, rule: .words(words))
    return (w.clippedLeft ? "… " : "") + w.left + w.mid + w.right + (w.clippedRight ? " …" : "")
  }

  /// The same excerpt split for display with the match emphasised.
  public static func parts(_ text: String, target: Range<Int>, words: Int) -> (left: String, mid: String, right: String) {
    let w = ContextWindow.make(passageText: text, target: target, rule: .words(words))
    return ((w.clippedLeft ? "… " : "") + w.left, w.mid, w.right + (w.clippedRight ? " …" : ""))
  }
}
