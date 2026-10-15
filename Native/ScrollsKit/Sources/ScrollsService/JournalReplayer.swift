// OWNER: N6
// Journal replay (IOS-SPEC §6.2, §6.5): applies journal entries strictly in `seq` order through the same code paths as
// live writes (`ProvenanceJournal.apply`), at launch (entries after `meta.journal_applied_seq`), into a generation being
// built (Atlas.next) and after a restore. Anchors resolve through DocKey, then original_sha256 + offsets, then a quote
// search (D18); an act whose anchor no longer resolves stays as an orphaned interpretation, never dropped. A missing
// input (a pack or an original that is not on the phone, or another package's act whose replay handler is not in this
// build) stops the replay there with a named reason (`ReplayReport.waiting`), because skipping it would break the
// prefix property D17 relies on (§6.4).
// This file also holds the write path every N6 route shares (`LiveAtlas.journaledAct`): a dry run of the reference's
// logic on the writer (rolled back) validates the request and yields the act's stable keys; then the act is appended
// to the journal (fsync) and applied in one transaction that records it (`UserWrites.perform`). LiveAtlas.open calls
// `JournalReplayer.replay` at its marked point once N0 wires it; until then the CLI and tests call it after open.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsProvenance
import ScrollsStore
import Synchronization

/// Replays the write-ahead journal into an atlas.
public enum JournalReplayer {
  /// Applies every entry with `seq > after` to `atlas` and reports what resolved, re-anchored, was orphaned, or waits.
  @concurrent
  public static func replay(into atlas: LiveAtlas, after seq: UInt64) async throws -> ReplayReport {
    let entries = try await ProvenanceJournal.entries(atlas.journal)
    let pending = entries.filter { $0.seq > seq }
    let outcome = try await ProvenanceJournal.replay(entries.filter { $0.seq <= seq } + pending, writer: atlas.writer, text: atlas.text)
    let report = ReplayReport(fromSeq: outcome.fromSeq, toSeq: outcome.toSeq, resolved: outcome.resolved,
                              reanchored: outcome.reanchored, orphaned: outcome.orphaned,
                              waiting: outcome.waiting.map { ReplayWait(seq: $0.seq, reason: $0.reason, waitingActs: $0.remaining) })
    reports.withLock { $0[ObjectIdentifier(atlas)] = report }
    if outcome.toSeq >= outcome.fromSeq { atlas.hub.send(.journal(outcome.toSeq)) }
    return report
  }

  /// The launch catch-up: replays what the journal holds beyond `meta.journal_applied_seq` (a crash between the append
  /// and the commit), then returns the report.
  @concurrent
  public static func catchUp(_ atlas: LiveAtlas) async throws -> ReplayReport {
    guard atlas.profile == .device else {
      return ReplayReport(fromSeq: 0, toSeq: 0, resolved: 0, reanchored: 0, orphaned: 0)
    }
    let applied = try await atlas.read { c in UInt64(try Meta.get(c, "journal_applied_seq") ?? "0") ?? 0 }
    return try await replay(into: atlas, after: applied)
  }

  /// The last report of a replay into `atlas` (what `AtlasPlatform.replayStatus()` serves once N0 wires it).
  public static func lastReport(for atlas: LiveAtlas) -> ReplayReport? {
    reports.withLock { $0[ObjectIdentifier(atlas)] }
  }

  private static let reports = Mutex<[ObjectIdentifier: ReplayReport]>([:])
}

/// The dry run's result travels out of the rolled-back transaction as an error.
private struct DryRunResult<T: Sendable>: Error {
  let value: T
}

extension LiveAtlas {
  /// Runs the reference's logic on the writer and rolls it back: the request is validated exactly as the act will be
  /// applied, and `build` turns the accepted request into its journal op (stable keys are read in the same snapshot).
  func dryRun<T: Sendable>(_ label: String, _ build: @Sendable (WriteContext) throws -> T) async throws -> T {
    let text = self.text
    do {
      _ = try await writer.write("dry run \(label)") { tx -> Int in
        throw DryRunResult(value: try build(WriteContext(tx: tx, text: text, at: StoreClock.isoNow())))
      }
    } catch let r as DryRunResult<T> {
      return r.value
    } catch let e as StoreError where e.isConstraint {
      throw ProvenanceError.constraint(e)
    }
    throw ScrollsError(code: .internalError, message: "Internal error.", hint: "The dry run returned nothing.", status: 500)
  }

  /// The act, journaled then applied (write-ahead, §6.2). Returns the reference's response body. On an atlas without
  /// the device profile (a reference database opened by the CLI) there is no journal: the act is applied directly.
  func journaledAct(_ op: JournalOp, actor: String, journal: [JournalEntry] = []) async throws -> JSONValue {
    let text = self.text
    do {
      guard profile == .device else {
        return try await writer.write("act \(op.name)") { tx in
          let entry = try JournalEntry(seq: 0, at: StoreClock.isoNow(), actor: actor, op: op)
          return try ProvenanceJournal.apply(entry, WriteContext(tx: tx, text: text, at: entry.at), journal: journal).response
        }
      }
      return try await userWrites.perform(op, actor: actor) { tx, entry in
        try ProvenanceJournal.apply(entry, WriteContext(tx: tx, text: text, at: entry.at), journal: journal).response
      }
    } catch let e as StoreError where e.isConstraint {
      throw ProvenanceError.constraint(e)
    }
  }

  /// The journal's entries, when an act refers to a hypothesis group (its key is the act that opened it).
  func journalEntries() async throws -> [JournalEntry] { try await ProvenanceJournal.entries(journal) }
}
