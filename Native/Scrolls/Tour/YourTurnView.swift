// OWNER: N8
// Your turn (IOS-SPEC §4.17, 55–60 s): the end of the first minute, in the inspector. The search field is focused above
// it; below, the start chips that the engine confirmed for Cipher (virus · zero · sample), Switch to Cipher (real data)
// — enabled once Cipher's phase A is done, otherwise showing the live percentage — and the Full tour (4 min).

import ScrollsContracts
import SwiftUI

struct YourTurnView: View {
  let model: AppModel

  var body: some View {
    let tour = model.experience.tour
    let cipher = model.jobs.health?.cipher
    let openable = CoachWords.cipherOpenable(cipher)
    let fixtures = model.engine.kind == .fixtures
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text(TourCopy.yourTurn).font(.title3.weight(.semibold)).foregroundStyle(Tokens.ink.color).accessibilityAddTraits(.isHeader)
        Spacer()
        Button(TourCopy.close) { model.experience.closeYourTurn() }
          .font(Typography.chrome)
          .frame(minHeight: Tokens.Geometry.minHit)
          .accessibilityIdentifier("yourTurnClose")
      }
      Text(CoachWords.cipherLine(cipher))
        .font(Typography.cardBody)
        .foregroundStyle(Tokens.ink2.color)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("cipherStatus")
      VStack(alignment: .leading, spacing: 6) {
        Text(TourCopy.startFrom).font(Typography.meta.weight(.semibold)).foregroundStyle(Tokens.ink3.color)
        if let chips = tour.chips {
          if chips.isEmpty {
            Text(TourCopy.nothingSuggested).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          } else {
            HStack(spacing: 8) {
              ForEach(chips) { chip in
                Button {
                  Task { await tour.use(chip) }
                } label: {
                  Text(chip.label)
                    .font(Typography.chrome)
                    .foregroundStyle(Tokens.ink.color)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 36)
                    .chromeGlass(in: Capsule(), interactive: true)
                }
                .buttonStyle(.plain)
                .frame(minHeight: Tokens.Geometry.minHit)
                .disabled(!openable)
                .accessibilityHint(chip.count.map(TourCopy.chipCount) ?? "")
                .accessibilityIdentifier("startChip.\(chip.label)")
              }
            }
          }
        } else {
          CountingLabel(TourCopy.checking, fraction: nil)
        }
        if fixtures { Text(TourCopy.fixtureNote).font(Typography.meta).foregroundStyle(Tokens.syn.color) }
      }
      Button {
        model.experience.setCorpus("cipher")
        model.experience.closeYourTurn()
      } label: {
        Group {
          if openable {
            Text(TourCopy.switchToCipher)
          } else {
            Text(CountingLabel.text(TourCopy.switchToCipher, fraction: cipher?.progress))
          }
        }
        .font(.body.weight(.semibold))
        .frame(maxWidth: .infinity, minHeight: Tokens.Geometry.minHit)
      }
      .buttonStyle(.borderedProminent)
      .tint(Tokens.cyan.color)
      .foregroundStyle(Tokens.bg0.color)
      .disabled(!openable)
      .accessibilityHint(TourCopy.switchHint)
      .accessibilityIdentifier("switchToCipher")
      Button(TourCopy.fullTour) { tour.openFullTour() }
        .font(Typography.chrome)
        .frame(minHeight: Tokens.Geometry.minHit)
        .accessibilityIdentifier("fullTour")
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("yourTurn")
  }
}
