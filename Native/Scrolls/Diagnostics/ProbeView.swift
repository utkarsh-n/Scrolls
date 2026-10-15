// OWNER: N0
// The M0 probe on this phone (IOS-SPEC §1.4, §3.8, §4.20, §8.4.10 item 4): runs the probe suite and shows its rows,
// or the last probe.json written on this device. Every row says PASS, FAIL, PENDING (could not run here, with the
// reason) or INFO (a measurement with no pass mark); colour backs the word, never replaces it.

import SwiftUI

nonisolated enum ProbeCopy {
  static let title = "Probe"
  static let run = "Run the probe"
  static let running = "Running"
  static let never = "The probe has not run on this device."
  static let lastRun = "Last run"
  static let written = "Written to Documents/Diagnostics/probe.json and Documents/selftest/"
}

struct ProbeView: View {
  @Environment(AppModel.self) private var model
  @State private var last: SelfTestResult? = SelfTestRunner.lastProbe()

  var body: some View {
    List {
      Section {
        Button {
          Task {
            if let result = await model.selfTests.run(.probe, model: model) { last = result }
          }
        } label: {
          Label(ProbeCopy.run, systemImage: "checklist")
        }
        .disabled(isRunning)
        .accessibilityIdentifier("runProbe")
        if case .running(let step, let done, let total) = model.selfTests.state {
          CountingLabel("\(ProbeCopy.running): \(step)", fraction: total > 0 ? Double(done) / Double(total) : nil)
        }
        if case .failedToWrite(let message) = model.selfTests.state {
          Text(message).font(Typography.meta).foregroundStyle(Tokens.danger.color)
        }
      } footer: {
        Text(ProbeCopy.written)
      }
      if let last {
        Section {
          ForEach(Array(last.rows.enumerated()), id: \.offset) { _, row in
            SelfTestRowView(row: row)
          }
        } header: {
          Text("\(ProbeCopy.lastRun) · \(last.run) · \(last.status.rawValue)")
        }
      } else {
        Section { Text(ProbeCopy.never).foregroundStyle(Tokens.ink2.color) }
      }
    }
    .scrollContentBackground(.hidden)
    .background(Tokens.bg0.color)
    .navigationTitle(ProbeCopy.title)
  }

  private var isRunning: Bool {
    if case .running = model.selfTests.state { return true }
    return false
  }
}

/// One result row: the status word with its symbol, the row's name and its detail.
struct SelfTestRowView: View {
  let row: SelfTestRow

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Label {
        Text(row.status.rawValue)
      } icon: {
        Image(systemName: symbol)
      }
      .labelStyle(.titleAndIcon)
      .font(Typography.badge)
      .foregroundStyle(colour)
      .frame(width: 92, alignment: .leading)
      VStack(alignment: .leading, spacing: 2) {
        Text(row.name).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
        Text(row.detail).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
    }
    .accessibilityElement(children: .combine)
  }

  private var symbol: String {
    switch row.status {
    case .pass: "checkmark.circle"
    case .fail: "xmark.octagon"
    case .pending: "hourglass"
    case .info: "info.circle"
    case .skip: "arrow.uturn.right.circle"
    }
  }

  private var colour: Color {
    switch row.status {
    case .pass: Tokens.ok.color
    case .fail: Tokens.danger.color
    case .pending, .skip: Tokens.ink2.color
    case .info: Tokens.ink3.color
    }
  }
}
