// OWNER: N8
// Settings (IOS-SPEC §4.6, §4.7, §4.21): the viewer's own motion setting (never part of a link or a view's hash), the
// modality seam as a line or a tick (never hidden), the strand height, haptics, and the coach marks again. Preferences
// the Scroll reads are stored under the keys of `ScrollsPreferences` (UserDefaults: per-device conveniences only).

import LabKitUI
import ScrollsCore
import SwiftUI

/// Per-device preferences other packages read (the Scroll draws the seam and the slot height from them).
nonisolated enum ScrollsPreferences {
  /// "line" (default) or "tick": the modality seam through every lane, or collapsed to a tick on the ruler.
  static let seamKey = "scrolls.seam"
  /// 16, 24 (default) or 32: a strand slot's height in points (§4.3).
  static let slotKey = "scrolls.slotHeight"
}

struct SettingsSheet: View {
  let model: AppModel
  @Environment(\.dismiss) private var dismiss
  @AppStorage(ScrollsPreferences.seamKey) private var seam = "line"
  @AppStorage(ScrollsPreferences.slotKey) private var slot = 24

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          InstrumentPanel("01", SettingsCopy.motion, caption: SettingsCopy.motionNote) {
            ChoiceChips([ChoiceChips<String>.Item("system", SettingsCopy.motionSystem), .init("on", SettingsCopy.motionOn),
                         .init("off", SettingsCopy.motionOff)],
                        selection: Binding(get: { model.viewState.reducedMotion }, set: { model.viewState.reducedMotion = $0 }),
                        columns: 3, identifierPrefix: "motion")
          }
          InstrumentPanel("02", SettingsCopy.seam, caption: SettingsCopy.seamNote) {
            ChoiceChips([ChoiceChips<String>.Item("line", SettingsCopy.seamLine), .init("tick", SettingsCopy.seamTick)],
                        selection: $seam, columns: 2, identifierPrefix: "seam")
          }
          InstrumentPanel("03", SettingsCopy.slot, caption: SettingsCopy.slotNote) {
            ChoiceChips([ChoiceChips<Int>.Item(16, SettingsCopy.slotCompact), .init(24, SettingsCopy.slotDefault),
                         .init(32, SettingsCopy.slotComfortable)],
                        selection: $slot, columns: 3, identifierPrefix: "slot")
          }
          InstrumentPanel("04", SettingsCopy.haptics) { HapticsPanel(engine: model.hapticEngine) }
          InstrumentPanel("05", SettingsCopy.tour) {
            Button(SettingsCopy.showCoachMarks) {
              dismiss()
              model.experience.tour.replay()
            }
            .frame(minHeight: Tokens.Geometry.minHit)
          }
        }
        .padding(16)
      }
      .background(Tokens.bg0.color)
      .navigationTitle(SettingsCopy.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button(SettingsCopy.done) { dismiss() } } }
    }
    .accessibilityIdentifier("settingsSheet")
  }
}
