// OWNER: N0
// The status chip at the TopBar's trailing edge (IOS-SPEC §4.3, §4.18): a determinate ring and a short label
// ("Cipher 45%", "paused: phone is hot"). The ring only ever shows a known fraction; work without one shows words.
// Glass chrome (§4.22), capped at `.accessibility1`. Tapping it opens the jobs or Sources sheet (N8 wires the action).

import SwiftUI

/// What the chip says.
nonisolated enum StatusChipState: Sendable, Equatable {
  /// Nothing running: a short state word ("Ready", "Fixtures").
  case idle(String)
  /// Work with a known fraction in [0, 1] ("Cipher", 0.45).
  case progress(String, Double)
  /// Work paused by the system, with the reason ("paused: phone is hot").
  case paused(String)
  /// Work that failed ("Cipher failed").
  case failed(String)

  /// The chip's words, including the percentage when there is one.
  var text: String {
    switch self {
    case .idle(let s), .paused(let s), .failed(let s): s
    case .progress(let s, let f): CountingLabel.text(s, fraction: f)
    }
  }
}

struct StatusChip: View {
  let state: StatusChipState
  var action: (() -> Void)?

  var body: some View {
    Button {
      action?()
    } label: {
      HStack(spacing: 6) {
        indicator
        Text(state.text)
          .font(Typography.chromeCount)
          .lineLimit(1)
          .contentTransition(.numericText())
      }
      .foregroundStyle(foreground)
      .padding(.horizontal, 10)
      .frame(minHeight: 32)
      .chromeGlass(in: Capsule(), interactive: action != nil)
    }
    .buttonStyle(.plain)
    .frame(minHeight: Tokens.Geometry.minHit)
    .contentShape(Rectangle())
    .disabled(action == nil)
    .chromeTypeCap()
    .accessibilityLabel(state.text)
    .accessibilityIdentifier("statusChip")
  }

  private var foreground: Color {
    switch state {
    case .failed: Tokens.danger.color
    case .paused: Tokens.amber.color
    default: Tokens.ink.color
    }
  }

  @ViewBuilder private var indicator: some View {
    switch state {
    case .progress(_, let f):
      ZStack {
        Circle().stroke(Tokens.rule.color, lineWidth: 2)
        Circle()
          .trim(from: 0, to: min(1, max(0, f)))
          .stroke(Tokens.ink.color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
          .rotationEffect(.degrees(-90))
      }
      .frame(width: 13, height: 13)
      .accessibilityHidden(true)
    case .paused:
      Image(systemName: "thermometer.high").imageScale(.small).accessibilityHidden(true)
    case .failed:
      Image(systemName: "exclamationmark.triangle").imageScale(.small).accessibilityHidden(true)
    case .idle:
      EmptyView()
    }
  }
}
