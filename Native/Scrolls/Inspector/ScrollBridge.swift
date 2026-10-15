// OWNER: N8
// The seam between the Scroll (N7) and the experience (N8). The frozen bus is `AppModel.viewState` (SPEC §8.2): the
// selection, the vantage, the strands, lanes and filters travel through it, and the inspector follows it whatever set
// it. What the view state cannot carry lives here, on the experience model (`model.experience.bridge`):
// - the Scroll's transport (Play, Step, speed), when the Scroll registers one; until then the transport row steps the
//   vantage itself, one bin at a time, and says nothing it does not know (no gap or seam pauses without coverage);
// - the tap sentence of an empty bin, a gap, a wash or the seam, shown in the peek row (§4.5 "its sentence");
// - the registered timeline query key, so the drawer and shelves ask for the query on screen;
// - the screen rectangles the coach marks point at (the first bar, the documented and computed arcs, the 1994 mark),
//   and the coach marks' static outlines, which the Scroll draws (§4.17: no pulse);
// - the strand labels the Scroll resolved (chip words).
// N7 writes these members; nothing else does. They are optional: every reader has a stated fallback.

import CoreGraphics
import Observation
import ScrollsCore

/// What the Scroll offers the transport row (§4.6). The Scroll owns Play's auto-pan, the gap and seam pauses, the fades
/// and its haptics; the row only asks.
@MainActor protocol ScrollTransport: AnyObject {
  /// True while Play runs.
  var isPlaying: Bool { get }
  /// The current speed (0.25×, 0.5×, 1×, 2×, 4×).
  var speed: Double { get set }
  /// Play ↔ pause (Magic Tap does the same).
  func togglePlay()
  /// One bin forward (+1) or back (−1).
  func step(_ direction: Int)
}

/// The places a coach mark can point at (`coachmarks.mjs` anchorRect / locate).
nonisolated enum CoachAnchor: String, Hashable, Sendable, CaseIterable {
  /// The first lane's earliest drawn bar (coach ①: the 1911 Classroom bar in the demo).
  case firstBar = "first-bar"
  /// A documented arc and a computed arc (coach ②).
  case documentedArc = "arc:documented"
  case computedArc = "arc:computed"
  /// The 1994 Hip-hop mark coach ② rings.
  case focusMark = "mark:focus"
  /// The transport row's ▶ (coach ③; the peek row reports it, not the Scroll).
  case playButton = "button:play"
}

/// A static outline the Scroll draws for a coach mark (§4.17: the 1940s hatch and the 1984–93 dotted stretch, 1 pt
/// cyan, never pulsing). Days, so the Scroll places it whatever the zoom.
nonisolated struct CoachOutline: Hashable, Sendable {
  var lane: String?
  var loDay: Int
  var hiDay: Int
  /// "uncovered" or "absent": which kind of gap it marks.
  var kind: String
}

@MainActor @Observable
final class ScrollBridge {
  /// The Scroll's transport, once it registers one (N7). Nil: the transport row's own vantage stepper answers.
  @ObservationIgnored weak var transport: (any ScrollTransport)?
  /// Bumped when `transport` is set, so views re-read it.
  private(set) var transportGeneration = 0

  /// The sentence of the last tapped empty bin, gap, wash, cap or seam (§4.1 rule 5), for the peek row. The Scroll
  /// builds it from the same numbers as the drawing; the peek row shows it verbatim.
  var peekSentence: String?
  /// The registered query key of the timeline on screen (`TimelineQueryResponse.queryKey`). Nil: the drawer registers
  /// the same canonical request itself (the key is deterministic).
  var queryKey: String?
  /// Screen rectangles (global coordinates) of what the coach marks point at; absent anchors fall back to fixed places.
  var anchors: [CoachAnchor: CGRect] = [:]
  /// Strand labels the Scroll resolved, by strand id ("12" → "carry the zero").
  var strandLabels: [String: String] = [:]
  /// Outlines the Scroll draws for the coach mark on screen (empty when none is).
  var coachOutlines: [CoachOutline] = []

  /// The Scroll registers its transport (N7 calls this once its model exists).
  func register(transport: any ScrollTransport) {
    self.transport = transport
    transportGeneration += 1
  }
}
