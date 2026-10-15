// OWNER: N8
// The year picker (IOS-SPEC §4.6): tapping "as of 1925" opens era chips (Deep time · Classical · Early modern · Modern)
// and a year wheel; the pick snaps to the end of the bin that holds that year (the vantage is discrete by bin), and
// "open" removes the limit. BCE years are astronomical inside and labelled historically.

import LabKitUI
import ScrollsCore
import ScrollsScrollModel
import SwiftUI

nonisolated enum YearPickerCopy {
  static let title = "As of"
  static let done = "Done"
  static let cancel = "Cancel"
  static let open = "No limit (open)"
  static let era = "Era"
  static let deepTime = "Deep time"
  static let classical = "Classical"
  static let earlyModern = "Early modern"
  static let modern = "Modern"
  static let note = "The vantage snaps to the end of the bin that holds the year: evidence dated later is hidden (strict) or faint (context)."
}

nonisolated enum Eras {
  /// The era chips and their year ranges (astronomical years).
  static let all: [(id: String, title: String, range: ClosedRange<Int>)] = [
    ("deep", YearPickerCopy.deepTime, -9999 ... -1001),
    ("classical", YearPickerCopy.classical, -1000 ... 1499),
    ("early", YearPickerCopy.earlyModern, 1500 ... 1799),
    ("modern", YearPickerCopy.modern, 1800 ... 2100),
  ]

  static func era(of year: Int) -> String { all.first { $0.range.contains(year) }?.id ?? "modern" }

  /// The wheel's years for an era, newest first: every year from 1500, every 10th before, every 100th in deep time.
  static func years(_ era: String) -> [Int] {
    guard let r = all.first(where: { $0.id == era })?.range else { return Array((1800...2100).reversed()) }
    let step = era == "deep" ? 100 : era == "classical" ? 10 : 1
    return Array(stride(from: r.upperBound - (r.upperBound - r.lowerBound) % step, through: r.lowerBound, by: -step))
  }

  /// The vantage day for a picked year: the end of the bin that holds it at the Scroll's tier.
  static func vantageDay(year: Int, tier: Tier) -> Int {
    let mid = DayMath.dayFromYMD(year, 7, 1)
    return min(ViewState.maxDay, VantageSteps.binEndDay(tier, VantageSteps.binOfDay(tier, mid)))
  }
}

extension RootSlots {
  func yearPicker() -> some View { YearPickerSheet(model: model) }
}

struct YearPickerSheet: View {
  let model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var year = 1925
  @State private var era = "modern"

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 14) {
        ChoiceChips(Eras.all.map { ChoiceChips<String>.Item($0.id, $0.title) }, selection: $era, columns: 2, identifierPrefix: "era")
          .onChange(of: era) { _, e in
            let ys = Eras.years(e)
            if !ys.contains(year) { year = e == "modern" ? 1925 : ys.first ?? 1925 }
          }
        Picker(YearPickerCopy.title, selection: $year) {
          ForEach(Eras.years(era), id: \.self) { y in
            Text(DateLabels.yearLabel(y)).tag(y)
          }
        }
        .pickerStyle(.wheel)
        .frame(maxHeight: 180)
        Text(YearPickerCopy.note).font(Typography.meta).foregroundStyle(Tokens.ink2.color).fixedSize(horizontal: false, vertical: true)
        Button(YearPickerCopy.open) {
          model.viewState.vantage.day = ViewState.vantageOpenDay
          dismiss()
        }
        .frame(minHeight: Tokens.Geometry.minHit)
        Spacer(minLength: 0)
      }
      .padding(16)
      .background(Tokens.bg0.color)
      .navigationTitle(YearPickerCopy.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(YearPickerCopy.cancel) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(YearPickerCopy.done) {
            model.viewState.vantage.day = Eras.vantageDay(year: year, tier: VantageSteps.tier(of: model.viewState))
            model.experience.haptics.play(.vantageStep)
            dismiss()
          }
          .accessibilityIdentifier("yearPickerDone")
        }
      }
      .onAppear {
        let y = DayMath.ymdFromDay(min(model.viewState.vantage.day, DayMath.today())).y
        year = max(-9999, min(2100, y))
        era = Eras.era(of: year)
      }
    }
    .presentationDetents([.medium])
    .accessibilityIdentifier("yearPicker")
  }
}
