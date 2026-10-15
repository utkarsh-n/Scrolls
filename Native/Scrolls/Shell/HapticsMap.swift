// OWNER: N8
// The haptic map (IOS-SPEC §4.21): which LabKitFeedback `HapticTap` each act plays, wrapping `AppModel.hapticEngine`.
// Transients only — no hum, no sound — and a hard rule: no haptic encodes a data magnitude. Nothing here takes a count,
// a rate or a score, so nothing can scale with one. A gate card plays nothing (a refusal is information, not an error
// buzz). The engine itself stops while the app is not active (Lifecycle → LabKit's start/stop).

import LabKitFeedback

/// The acts of Scrolls that answer with a tap. A case carries no value: the map cannot be fed a magnitude.
nonisolated enum ScrollsHaptic: String, CaseIterable, Sendable {
  /// The bin tier changed while pinching: zoom has detents, like a knob.
  case tierChange
  /// The vantage stepped one bin (scrub or Play): time advancing. Throttled by the tap's own gap (≤ 22 a second).
  case vantageStep
  /// The vantage entered a stretch with no coverage: an honest "nothing here".
  case noCoverage
  /// The modality seam was crossed, a pan hit the domain edge, or a pinch entered the folded overview.
  case boundary
  /// A feedback halo appeared: a later work re-reads an earlier one (an event, never a magnitude).
  case halo
  /// A mark or an edge was selected.
  case select
  /// A review recorded, a view saved, a pack loaded.
  case success
  /// A gate card is shown: deliberately silent.
  case gateShown

  /// Why this act plays what it plays (How Scrolls works → 08, EXPERIENCE.md).
  var why: String {
    switch self {
    case .tierChange: "zoom has detents, like a knob"
    case .vantageStep: "time advancing"
    case .noCoverage: "an honest \u{201C}nothing here\u{201D}"
    case .boundary: "a change of medium or regime, not of meaning"
    case .halo: "a later work re-reads an earlier one: an event, never a magnitude"
    case .select: "a mark or edge is selected"
    case .success: "a review recorded, a view saved, a pack loaded"
    case .gateShown: "none: a refusal is information, not an error buzz"
    }
  }

  /// The words of the tap in the table (`.detent`, `success()`, `none`).
  var tapName: String {
    switch self {
    case .tierChange: ".detent"
    case .vantageStep: ".tick"
    case .noCoverage: ".soft"
    case .boundary: ".boundary"
    case .halo: ".ripple"
    case .select: ".select"
    case .success: "success()"
    case .gateShown: "none"
    }
  }

  /// LabKit's transient for the act; nil for `success` (the engine's own success pattern) and for a gate (silent).
  var tap: HapticTap? {
    switch self {
    case .tierChange: .detent
    case .vantageStep: .tick
    case .noCoverage: .soft
    case .boundary: .boundary
    case .halo: .ripple
    case .select: .select
    case .success, .gateShown: nil
    }
  }
}

/// The act → haptic map (N8), over LabKit's engine.
final class HapticsMap {
  let engine: HapticEngine
  /// Every act played, newest last (Diagnostics and tests; bounded).
  private(set) var log: [ScrollsHaptic] = []

  init(engine: HapticEngine) {
    self.engine = engine
  }

  /// Plays the act's tap. A gate card plays nothing, by design.
  func play(_ act: ScrollsHaptic) {
    log.append(act)
    if log.count > 64 { log.removeFirst(log.count - 64) }
    switch act {
    case .gateShown: return
    case .success: engine.success()
    default: if let tap = act.tap { engine.play(tap) }
    }
  }
}
