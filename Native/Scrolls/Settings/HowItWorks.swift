// OWNER: N8
// How Scrolls works (IOS-SPEC §4.22): LabKit's `LabInfoSheet` with numbered panels in LabKit's fixed order — 01 What
// you're looking at · 02 Touch · 03 What you're seeing (the encodings, with drawn swatches) · 04 Controls · 05 Presets ·
// 06 What's documented, computed and proposed (+ synthetic) · 07 On this phone · 08 Sound & feel (haptics only: Scrolls
// has no sound) · 09 Sources & licences (every licence and attribution of SPEC §13.15). LabKit's measured/modelled
// provenance words never appear here (I3).

import LabKitFeedback
import LabKitUI
import ScrollsCore
import SwiftUI

extension RootSlots {
  func howItWorks() -> some View { HowItWorksSheet(model: model) }
  func settings() -> some View { SettingsSheet(model: model) }
}

struct HowItWorksSheet: View {
  let model: AppModel

  var body: some View {
    LabInfoSheet(title: HowItWorksCopy.title) {
      InstrumentPanel("01", HowItWorksCopy.p01) {
        Text(HowItWorksCopy.lookingAt).fixedSize(horizontal: false, vertical: true)
        Text(HowItWorksCopy.firstObserved).font(.subheadline).foregroundStyle(Tokens.ink2.color).fixedSize(horizontal: false, vertical: true)
      }
      InstrumentPanel("02", HowItWorksCopy.p02) { rows(HowItWorksCopy.touch) }
      InstrumentPanel("03", HowItWorksCopy.p03, caption: Copy.laneOrderNote) {
        ForEach(EvidenceStyle.legendRows.filter { $0.group == "bins" }, id: \.key) { LegendLine(row: $0) }
      }
      InstrumentPanel("04", HowItWorksCopy.p04) { rows(HowItWorksCopy.controls) }
      InstrumentPanel("05", HowItWorksCopy.p05) { rows(HowItWorksCopy.presets) }
      InstrumentPanel("06", HowItWorksCopy.p06) {
        rows(HowItWorksCopy.evidence)
        ForEach(EvidenceStyle.legendRows.filter { $0.group == "evidence" }, id: \.key) { LegendLine(row: $0) }
      }
      InstrumentPanel("07", HowItWorksCopy.p07) {
        Text(HowItWorksCopy.onPhone).fixedSize(horizontal: false, vertical: true)
        LabeledContent(HowItWorksCopy.onPhoneEngine, value: model.engine.summary)
        if let h = model.jobs.health {
          LabeledContent(HowItWorksCopy.onPhoneData, value: Format.int(h.dataVersion))
          LabeledContent(HowItWorksCopy.onPhoneJobs, value: ShellCopy.jobsLine(running: h.jobs.running, queued: h.jobs.queued))
        }
      }
      InstrumentPanel("08", HowItWorksCopy.p08) { HapticsPanel(engine: model.hapticEngine, showMap: true) }
      InstrumentPanel("09", HowItWorksCopy.p09, caption: HowItWorksCopy.localOnly) {
        ForEach(HowItWorksCopy.sources, id: \.title) { s in
          VStack(alignment: .leading, spacing: 2) {
            Text(s.title).font(.subheadline.weight(.semibold))
            Text(s.text).font(.footnote).foregroundStyle(Tokens.ink2.color).fixedSize(horizontal: false, vertical: true)
          }
          .accessibilityElement(children: .combine)
        }
      }
    }
    .accessibilityIdentifier("howItWorks")
  }

  private func rows(_ items: [(icon: String, title: String, text: String)]) -> some View {
    ForEach(items, id: \.title) { InfoRow($0.icon, $0.title, $0.text) }
  }
}

/// Panel 08: haptics on or off, their strength, a detent to feel, and the map of what each tap means (§4.21). There is
/// no sound and no sound control.
struct HapticsPanel: View {
  let engine: HapticEngine
  var showMap = false

  var body: some View {
    let enabled = Binding(get: { engine.enabled }, set: { engine.enabled = $0 })
    let strength = Binding(get: { Double(engine.strength) }, set: { engine.strength = Float($0) })
    VStack(alignment: .leading, spacing: 12) {
      GlassToggle(SettingsCopy.haptics, isOn: enabled, icon: "hand.tap.fill", note: SettingsCopy.hapticsNote)
        .accessibilityIdentifier("settings-haptics")
      VStack(alignment: .leading, spacing: 2) {
        Label(SettingsCopy.strength, systemImage: "dial.medium")
        Slider(value: strength, in: 0.2...1, step: 0.05) { editing in
          if !editing { engine.play(.detent) }
        }
        .tint(Tokens.cyan.color)
        .frame(minHeight: Tokens.Geometry.minHit)
        .accessibilityLabel(SettingsCopy.strength)
        .accessibilityValue("\(Int((Double(engine.strength) * 100).rounded())) percent")
      }
      .disabled(!engine.enabled)
      .opacity(engine.enabled ? 1 : 0.5)
      Button(SettingsCopy.feelDetent, systemImage: "hand.tap") { engine.play(.detent) }
        .buttonStyle(.glass)
        .frame(minHeight: Tokens.Geometry.minHit)
        .disabled(!engine.enabled)
      Text(SettingsCopy.soundNote).font(.footnote).foregroundStyle(Tokens.ink2.color)
      if showMap {
        Text(HowItWorksCopy.hapticMap).font(.subheadline.weight(.semibold))
        ForEach(ScrollsHaptic.allCases, id: \.self) { act in
          HStack(alignment: .firstTextBaseline) {
            Text(act.tapName).font(Typography.code).frame(width: 84, alignment: .leading)
            Text(act.why).font(.footnote).foregroundStyle(Tokens.ink2.color).fixedSize(horizontal: false, vertical: true)
          }
          .accessibilityElement(children: .combine)
        }
      }
    }
  }
}
