// OWNER: N8
// The inspector's peek row (IOS-SPEC §4.1 rule 2, §4.3, §4.6, §4.9): where the thumbs live — the search field, then the
// transport row: ▶ Play · Step ▸ · "as of 1925" · the strict/context eye. Long-pressing ▶ opens the speed knob (LabKit's
// GlassKnob, detents 0.25×–4×, the only continuous control). Under Reduce Motion Step ▸ becomes the filled primary
// control. Focusing the field raises the inspector to large with the keyboard.

import LabKitCore
import LabKitUI
import SwiftUI

struct PeekRow: View {
  let model: AppModel
  /// The height the two rows share (the sheet's peek content); each row gets half, at most 44 pt.
  let available: CGFloat
  @FocusState private var searchFocused: Bool
  @State private var speedTray = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var rowHeight: CGFloat { max(36, min(Tokens.Geometry.minHit, available / 2)) }

  var body: some View {
    let experience = model.experience
    VStack(spacing: 0) {
      searchRow(experience)
        .frame(height: rowHeight)
      transportRow(experience)
        .frame(height: rowHeight)
    }
    .padding(.horizontal, Tokens.Geometry.gutter)
    .chromeTypeCap()
    .onChange(of: experience.focusSearchRequest) { _, _ in searchFocused = true }
    .onChange(of: searchFocused) { _, focused in
      if focused {
        if experience.mode == .yourTurn { experience.raise(to: .large) } else { experience.beginSearch() }
      }
    }
    .onChange(of: experience.mode) { _, mode in
      if mode != .search, mode != .yourTurn { searchFocused = false }
    }
  }

  // MARK: Search

  private func searchRow(_ experience: ExperienceModel) -> some View {
    @Bindable var search = experience.search
    return HStack(spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass").foregroundStyle(Tokens.ink3.color).accessibilityHidden(true)
        TextField(SearchCopy.placeholder, text: $search.text)
          .focused($searchFocused)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.search)
          .onSubmit { experience.search.runNow() }
          .onChange(of: search.text) { _, text in
            if !text.isEmpty, experience.mode == .yourTurn { experience.beginSearch() }
          }
          .font(.body)
          .foregroundStyle(Tokens.ink.color)
          .accessibilityLabel(SearchCopy.fieldLabel)
          .accessibilityIdentifier("searchField")
        if !search.text.isEmpty {
          Button {
            experience.search.clear()
          } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(Tokens.ink3.color)
          }
          .buttonStyle(.plain)
          .frame(minWidth: 32, minHeight: rowHeight)
          .contentShape(Rectangle())
          .accessibilityLabel(SearchCopy.clear)
        }
      }
      .padding(.horizontal, 12)
      .frame(maxHeight: rowHeight - 6)
      .background(Tokens.bg1.opacity(0.85), in: Capsule())
      .overlay { Capsule().strokeBorder(Tokens.rule.color, lineWidth: 1) }
      .contentShape(Capsule())
      .onTapGesture { searchFocused = true }
      if experience.mode == .search || searchFocused {
        Button(SearchCopy.cancel) {
          searchFocused = false
          experience.endSearch()
        }
        .font(Typography.chrome)
        .foregroundStyle(Tokens.cyan.color)
        .frame(minHeight: rowHeight)
        .accessibilityIdentifier("searchCancel")
      }
    }
  }

  // MARK: Transport

  private func transportRow(_ experience: ExperienceModel) -> some View {
    let t = experience.transport
    return HStack(spacing: 8) {
      playButton(t)
      stepButton(t)
      Spacer(minLength: 4)
      Button {
        model.coordinator.present(.yearPicker)
      } label: {
        Text(t.asOfText)
          .font(Typography.chromeCount)
          .foregroundStyle(Tokens.ink.color)
          .lineLimit(1)
          .padding(.horizontal, 12)
          .frame(maxHeight: rowHeight - 8)
          .chromeGlass(in: Capsule(), interactive: true)
      }
      .buttonStyle(.plain)
      .frame(minHeight: rowHeight)
      .contentShape(Rectangle())
      .accessibilityIdentifier("asOf")
      Button {
        t.toggleMode()
      } label: {
        HStack(spacing: 4) {
          Image(systemName: t.isStrict ? "eye.slash" : "eye")
          Text(t.isStrict ? TransportCopy.strict : TransportCopy.context).font(Typography.chrome)
        }
        .foregroundStyle(Tokens.ink2.color)
        .padding(.horizontal, 10)
        .frame(maxHeight: rowHeight - 8)
        .chromeGlass(in: Capsule(), interactive: true)
      }
      .buttonStyle(.plain)
      .frame(minHeight: rowHeight)
      .contentShape(Rectangle())
      .accessibilityLabel(TransportCopy.modeLabel)
      .accessibilityValue(t.isStrict ? TransportCopy.strict : TransportCopy.context)
      .accessibilityHint(TransportCopy.strictHint)
      .accessibilityIdentifier("vantageMode")
    }
  }

  private func playButton(_ t: TransportModel) -> some View {
    let playing = t.isPlaying
    return Image(systemName: playing ? "pause.fill" : "play.fill")
      .font(.body.weight(.semibold))
      .foregroundStyle(reduceMotion ? Tokens.ink2.color : Tokens.bg0.color)
      .frame(width: 52, height: rowHeight - 6)
      .background(reduceMotion ? Tokens.bg2.color : Tokens.cyan.color, in: Capsule())
      .frame(minWidth: Tokens.Geometry.minHit, minHeight: rowHeight)
      .contentShape(Rectangle())
      .onTapGesture { t.togglePlay() }
      .onLongPressGesture(minimumDuration: 0.45) { speedTray = true }
      .popover(isPresented: $speedTray) { SpeedTray(transport: t).presentationCompactAdaptation(.popover) }
      .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { model.experience.bridge.anchors[.playButton] = $0 }
      .accessibilityElement()
      .accessibilityLabel(playing ? TransportCopy.pause : TransportCopy.play)
      .accessibilityHint(TransportCopy.playHint)
      .accessibilityAddTraits(.isButton)
      .accessibilityAction { t.togglePlay() }
      .accessibilityAction(named: TransportCopy.speed) { speedTray = true }
      .accessibilityIdentifier("play")
  }

  private func stepButton(_ t: TransportModel) -> some View {
    Button {
      t.step(1)
    } label: {
      HStack(spacing: 4) {
        Text(TransportCopy.step).font(Typography.chrome)
        Image(systemName: "forward.frame.fill").imageScale(.small)
      }
      .foregroundStyle(reduceMotion ? Tokens.bg0.color : Tokens.ink.color)
      .padding(.horizontal, 12)
      .frame(maxHeight: rowHeight - 6)
      .background {
        if reduceMotion { Capsule().fill(Tokens.cyan.color) }
      }
      .chromeGlassUnless(reduceMotion, in: Capsule())
    }
    .buttonStyle(.plain)
    .frame(minHeight: rowHeight)
    .contentShape(Rectangle())
    .accessibilityHint(TransportCopy.stepHint)
    .accessibilityIdentifier("step")
  }
}

/// The play-speed knob (§4.6): one GlassKnob, a five-way rotary switch 0.25×–4×.
private struct SpeedTray: View {
  let transport: TransportModel

  private static let spec = ParamSpec(
    "scrolls.playSpeed", title: TransportCopy.speed, icon: "metronome", range: 0...4, defaultValue: 2,
    detents: PlaySpeed.labels.enumerated().map { Detent(Double($0.offset), $0.element) }, step: 1,
    hint: TransportCopy.speedHint, format: .labels(PlaySpeed.labels))

  var body: some View {
    let binding = Binding<Double>(
      get: { Double(PlaySpeed.all.firstIndex(of: transport.speed) ?? 2) },
      set: { transport.speed = PlaySpeed.all[max(0, min(PlaySpeed.all.count - 1, Int($0.rounded())))] })
    GlassKnob(spec: Self.spec, value: binding, style: .card)
      .padding(16)
      .frame(width: 220)
      .accessibilityIdentifier("speedKnob")
  }
}

extension View {
  /// Glass unless `off` (the filled primary control under Reduce Motion is opaque).
  @ViewBuilder
  func chromeGlassUnless<S: Shape>(_ off: Bool, in shape: S) -> some View {
    if off { self } else { chromeGlass(in: shape, interactive: true) }
  }
}
