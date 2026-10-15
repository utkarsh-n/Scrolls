// OWNER: N0
// The write-ahead protocol of every user act (IOS-SPEC §6.2): append the op to the journal and fsync, then apply it in
// one atlas transaction that also records `journal_applied` and `meta.journal_applied_seq`. So the atlas never holds
// user rows the journal lacks; an op whose transaction failed stays in the journal and is applied again by the launch
// catch-up (JournalReplayer, N6), which is deterministic and idempotent by seq.

import ScrollsContracts
import ScrollsStore

/// Performs journaled writes for LiveAtlas and the journal replayer.
public struct UserWrites: Sendable {
  public let journal: JournalFile
  public let writer: Writer
  /// Called with the journal head after each append (`AtlasEvent.journal`).
  private let onAppend: @Sendable (UInt64) -> Void

  public init(journal: JournalFile, writer: Writer, onAppend: @escaping @Sendable (UInt64) -> Void = { _ in }) {
    self.journal = journal
    self.writer = writer
    self.onAppend = onAppend
  }

  /// Appends `op` (durably), then runs `apply` with the new entry in one `BEGIN IMMEDIATE` transaction that also
  /// records the entry as applied. Returns what `apply` returns.
  public func perform<T: Sendable>(_ op: JournalOp, actor: String,
                                   apply: @Sendable (WriteTx, JournalEntry) throws -> T) async throws -> T {
    let entry = try await journal.append(op, actor: actor)
    onAppend(entry.seq)
    return try await writer.write("journal \(entry.seq) \(op.name)") { tx in
      let out = try apply(tx, entry)
      try tx.recordJournalApplied(entry)
      return out
    }
  }

  /// Applies an entry already in the journal (launch catch-up, a generation's replay): the same transaction as
  /// `perform`, without appending.
  public func reapply<T: Sendable>(_ entry: JournalEntry,
                                   apply: @Sendable (WriteTx, JournalEntry) throws -> T) async throws -> T {
    try await writer.write("replay \(entry.seq) \(entry.op.name)") { tx in
      let out = try apply(tx, entry)
      try tx.recordJournalApplied(entry)
      return out
    }
  }
}
