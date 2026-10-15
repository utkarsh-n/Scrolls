// OWNER: N8
// The Jobs tray (IOS-SPEC §4.18, §1.5; port of `panels/jobs-tray.mjs`): the engine's jobs, active first (running,
// cancelling, queued), then finished, newest first. Every running job shows a number ("counting… 41%"), never a bare
// spinner; a failed job shows the engine's message and hint; Cancel asks the engine, and the final "cancelled" arrives
// with the next refresh. Opened from the status chip or More → Jobs; Sources and storage is one tap away.

import ScrollsContracts
import ScrollsCore
import ScrollsStore
import SwiftUI

nonisolated enum JobsTrayCopy {
  static let title = "Jobs"
  static let done = "Done"
  static let none = "No jobs have run in this atlas yet."
  static let cancel = "Cancel"
  static let sources = "Sources and storage"
  static let loading = "reading the job list…"
  static let fixtures = "Contract fixtures: these jobs are canned, not work on this phone."

  /// `JOB_LABELS`.
  static let labels: [String: String] = [
    "_noop": "Test job", "import": "Import", "revert": "Revert an import", "bootstrap-cipher": "Cipher import",
    "adapter-load": "Load a staged source", "demo-load": "Load the demo corpus", "materialize": "Counting matches",
    "export": "Export", "tokstream": "Token streams", "collocations": "Neighbouring terms", "vectors": "Word vectors",
    "cluster": "Context groups", "drift": "Displacement measures", "tone": "Machine tone", "layout": "Constellation layout",
    "boilerplate": "Boilerplate pass", "reuse-index": "Reuse index", "trace": "Quotation trace", "gc-runs": "Clean up old runs",
    "pack-install": "Install a source pack", "generation-build": "Build an atlas generation", "generation-swap": "Swap atlas generations",
    "journal-replay": "Replay the notebook", "maintenance": "Maintenance",
  ]
  /// `STATUS_WORDS`.
  static let status: [String: String] = [
    "queued": "queued", "running": "running", "succeeded": "done", "failed": "failed", "cancelling": "cancelling…",
    "cancelled": "cancelled", "interrupted": "interrupted (the app stopped)",
  ]
}

nonisolated enum JobRules {
  static let active: Set<String> = ["queued", "running", "cancelling"]

  /// `countsText`: '79 of 188 documents', or 'k 4 · occurrences 340'.
  static func countsText(_ counts: JSONValue?) -> String {
    guard let o = counts?.objectValue else { return "" }
    let entries = o.keys.sorted().compactMap { k in o[k]?.numberValue.map { (k, $0) } }
    if let of = o["of"]?.numberValue, entries.count == 2, let (k, v) = entries.first(where: { $0.0 != "of" }) {
      return "\(Format.int(Int(v))) of \(Format.int(Int(of))) \(k.replacing("_", with: " "))"
    }
    return entries.map { "\($0.0.replacing("_", with: " ")) \(Format.int(Int($0.1)))" }.joined(separator: " · ")
  }

  /// `sortJobs`: active first (running, cancelling, queued), newest first within each; then finished, newest first.
  static func sorted(_ jobs: [JobResponse]) -> [JobResponse] {
    let order = ["running": 0, "cancelling": 1, "queued": 2]
    return jobs.sorted { x, y in
      let ox = order[x.status] ?? 9, oy = order[y.status] ?? 9
      if ox != oy { return ox < oy }
      if ox == 9 {
        let wx = x.finishedAt ?? x.startedAt ?? x.createdAt, wy = y.finishedAt ?? y.startedAt ?? y.createdAt
        if wx != wy { return wx > wy }
      }
      return x.id > y.id
    }
  }
}

extension RootSlots {
  func jobsTray() -> some View { JobsTray(model: model) }
}

struct JobsTray: View {
  let model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var jobs: LoadState<[JobResponse]> = .idle

  var body: some View {
    NavigationStack {
      List {
        if model.engine.kind == .fixtures {
          Text(JobsTrayCopy.fixtures).font(Typography.meta).foregroundStyle(Tokens.syn.color)
        }
        switch jobs {
        case .idle, .loading:
          CountingLabel(JobsTrayCopy.loading, fraction: nil)
        case .failed(let card):
          ErrorCard(card) { Task { await load() } }
        case .loaded(let list):
          if list.isEmpty { Text(JobsTrayCopy.none).foregroundStyle(Tokens.ink2.color) }
          ForEach(list, id: \.id) { job in row(job) }
        }
        Button(JobsTrayCopy.sources) {
          model.coordinator.dismissAll()
          Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            model.coordinator.present(.sources)
          }
        }
      }
      .scrollContentBackground(.hidden)
      .background(Tokens.bg0.color)
      .navigationTitle(JobsTrayCopy.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button(JobsTrayCopy.done) { dismiss() } } }
      .task(id: model.jobs.health?.dataVersion ?? -1) { await load() }
      .task(id: model.jobs.chip) { await load() }
    }
    .presentationDetents([.medium, .large])
    .accessibilityIdentifier("jobsTray")
  }

  private func row(_ job: JobResponse) -> some View {
    let active = JobRules.active.contains(job.status)
    let fraction = job.progress.isFinite ? min(1, max(0, job.progress)) : nil
    let label = JobsTrayCopy.labels[job.type] ?? job.type
    let detail = [job.phase, job.message].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
    return VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(label).font(Typography.cardBody.weight(.semibold)).foregroundStyle(Tokens.ink.color)
        Spacer()
        if active, job.status == "running" {
          CountingLabel(JobsTrayCopy.status["running"] ?? "running", fraction: fraction)
        } else {
          Text(JobsTrayCopy.status[job.status] ?? job.status).font(Typography.count)
            .foregroundStyle(job.status == "failed" ? Tokens.danger.color : job.status == "succeeded" ? Tokens.ok.color : Tokens.ink2.color)
        }
      }
      if !detail.isEmpty { Text(detail).font(Typography.meta).foregroundStyle(Tokens.ink2.color) }
      let counts = JobRules.countsText(job.counts)
      if !counts.isEmpty { Text(counts).font(Typography.count).foregroundStyle(Tokens.ink3.color) }
      if let e = job.error?.objectValue {
        Text(e["message"]?.stringValue ?? e["code"]?.stringValue ?? "failed").font(Typography.meta).foregroundStyle(Tokens.danger.color)
        if let hint = e["hint"]?.stringValue { Text(hint).font(Typography.meta).foregroundStyle(Tokens.ink2.color) }
      }
      if job.status == "queued" || job.status == "running" {
        Button(JobsTrayCopy.cancel, role: .destructive) {
          Task {
            _ = try? await model.atlas?.cancelJob(JobID(rawValue: Int64(job.id)))
            await load()
          }
        }
        .font(Typography.chrome)
        .frame(minHeight: Tokens.Geometry.minHit)
      }
    }
    .listRowBackground(Tokens.bg1.color)
    .accessibilityElement(children: .combine)
  }

  private func load() async {
    guard let atlas = model.atlas else { return }
    if jobs.value == nil { jobs = .loading }
    do {
      jobs = .loaded(JobRules.sorted(try await atlas.jobs(JobsRequest(limit: 50)).items))
    } catch {
      jobs = .failed(ErrorCardModel(any: error))
    }
  }
}
