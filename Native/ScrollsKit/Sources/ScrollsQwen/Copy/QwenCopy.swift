// OWNER: Q (created by the bring-up, B2)
// The words every Qwen surface uses (IOS-SPEC-QWEN §3, Q-10). Machine readings are a fourth class beside observed,
// computed and human: never evidence, never "verified". The badge names the model and where it ran; on the phone it
// is exactly "machine reading (Qwen3-4B, on this iPhone) — not evidence".

import Foundation

public enum QwenCopy {
  public static func whereRan(_ b: BuiltOn) -> String {
    switch b {
    case .device: "on this iPhone"
    case .simulator: "in the iOS Simulator on a Mac"
    case .mac: "on a Mac"
    case .recorded: "recorded earlier, not computed now"
    }
  }

  /// The badge on every generated reading.
  public static func machineBadge(_ b: BuiltOn, model: String = "Qwen3-4B") -> String {
    "machine reading (\(model), \(whereRan(b))) — not evidence"
  }

  /// The note on computed groups (vectors and k-means are computed, not generated).
  public static func computedBadge(_ b: BuiltOn) -> String {
    "computed groups (Qwen3-Embedding-0.6B vectors and k-means, \(whereRan(b))): a reading of contexts, not senses"
  }

  public static let screenTitle = "Qwen on this iPhone"
  public static let modelsMissing = "The models are not on this phone. On your Mac: Tools/models.sh push"
  public static let unverified = "Not loaded: the files do not match the sha256 compiled into Scrolls."
  public static let demoIntro = demoIntro(model: "Qwen3.5 2B")
  public static func demoIntro(model: String) -> String {
    "A live demonstration: real passages containing ‘bank’ from public-domain books are read by Qwen3-Embedding on this phone, split into two groups by k-means, and each group is named by \(model)."
  }
  public static let noNetwork = "Nothing leaves the phone: the models are local files, and Scrolls has no network code."
  public static let stoppedAtCap = "Qwen's label stopped at its length limit; nothing is shown."
  public static let notShown = "Nothing is shown: the reading did not pass the checks."

  public static func refused(role: ModelRole, needed: Int, available: Int) -> String {
    let name = role == .embedder ? "Qwen3-Embedding" : "The selected Qwen text model"
    return "\(name) was not loaded: it needs about \(mb(needed)) of memory and the phone has \(mb(available)) free for Scrolls."
  }

  public static func mb(_ bytes: Int) -> String {
    bytes >= 1_000_000_000 ? String(format: "%.2f GB", Double(bytes) / 1e9) : String(format: "%.0f MB", Double(bytes) / 1e6)
  }

  public static func selection(_ s: String) -> String { "Selection: \(s)." }

  /// §5.10's header over the forced-k demonstration. On the phone with 60 passages it is exactly the spec's text;
  /// elsewhere it names where it ran (the simulator is not "this iPhone").
  public static func runtimeCheckHeader(passages: Int, builtOn b: BuiltOn) -> String {
    "Runtime check: two groups forced (k = 2) on \(passages) passages, with no reliability test. This shows that Qwen runs \(b == .device ? "on this iPhone" : whereRan(b)); it is not how Scrolls finds context groups."
  }

  /// The chip every machine card carries (rule 19).
  public static let machineChip = "machine reading"

  /// Rule 27's footer, closing every machine card. On the phone it is exactly the spec's text.
  public static func machineFooter(_ b: BuiltOn, model: String = "Qwen3-4B (2025)") -> String {
    "Machine reading by \(model), \(whereRan(b)) — not evidence. A modern model's reading of these passages: it can be wrong, and it reads old text with today's sense of words. Quotes and dates come from the atlas, not the model."
  }

  /// §3.6: the computed words come first and are not machine text.
  public static func computedWords(_ words: [String]) -> String { "computed words: " + words.joined(separator: " · ") }
}
