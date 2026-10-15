// OWNER: N0
// A read-only connection confined to its own actor on its own DispatchSerialQueue (IOS-SPEC §1.5). A request runs
// inside one BEGIN DEFERRED, so a handler that issues several statements (a timeline query plus its lane gates) sees
// one WAL snapshot; no transaction is held across an await.

import Dispatch
import Foundation
import ScrollsContracts

/// Which readers a read may use: reader 0 is reserved for `.interactive`.
public enum ReadLane: Sendable { case interactive, job }

/// One reader: a `query_only` connection on its own serial queue.
public actor ReadConnection {
  private let queue: DispatchSerialQueue
  private let connection: Connection
  /// Interrupts this reader's running request (thread-safe).
  nonisolated let gate: InterruptGate

  public nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

  /// Opens a reader on `path`. `qos` is the queue's quality of service (`.userInitiated` for the interactive reader).
  public init(path: String, profile: StoreProfile, mmapBytes: Int = 0, qos: DispatchQoS = .utility,
              label: String = "scrolls.reader", immutable: Bool = false) throws {
    queue = DispatchSerialQueue(label: label, qos: qos)
    connection = try Connection(path: path, mode: immutable ? .readOnlyImmutable : .readOnly, profile: profile,
                                mmapBytes: mmapBytes)
    gate = connection.interruptGate
  }

  /// Runs `body` in one read transaction. A `deadline` (from now) that expires stops the statement and throws
  /// `QUERY_TIMEOUT`; task cancellation stops it and throws `CancellationError`.
  public func run<T: Sendable>(deadline: Duration?, _ body: @Sendable (Connection) throws -> T) throws -> T {
    try run(request: ReadPool.nextRequestID(), deadline: deadline, body)
  }

  func run<T: Sendable>(request: UInt64, deadline: Duration?, heartbeat: (@Sendable () -> Void)? = nil,
                        _ body: @Sendable (Connection) throws -> T) throws -> T {
    try Task.checkCancellation()
    connection.beginRequest(token: request)
    defer {
      connection.setDeadline(nil)
      connection.setHeartbeat(nil)
      connection.endRequest()
    }
    connection.setDeadline(deadline.map { ContinuousClock.now + $0 })
    connection.setHeartbeat(heartbeat)
    do {
      return try connection.transaction(.deferred) { try body(connection) }
    } catch let e as StoreError where e.isInterrupt {
      if connection.interruptReason == .deadline, let deadline {
        throw StoreFailures.queryTimeout(deadline)
      }
      if Task.isCancelled || connection.interruptReason == .cancelled { throw CancellationError() }
      throw e
    }
  }

  /// Closes the connection (a swap); later requests fail.
  public func close() { connection.close() }

  /// Drops the decoded text chunks this reader caches (a memory warning).
  public func trim() { ChunkedTextStore.trim(connection) }
}
