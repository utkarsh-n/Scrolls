// OWNER: N0
// Backpressure between an adapter and its writer (IOS-SPEC §1.5): the producer `send`s batches and suspends while the
// channel is full; the consumer drains it with `next()`. AsyncStream is never used for data — it has no backpressure.
// Senders are served in arrival order; a cancelled sender leaves the queue and throws CancellationError.

import Foundation

/// Thrown by `send` after `finish()`.
public struct ChannelClosed: Error, Sendable, Equatable {
  public init() {}
}

/// A FIFO channel holding at most `capacity` elements.
public actor BoundedChannel<Element: Sendable> {
  private var buffer: [Element] = []
  private var head = 0
  private var senders: [(id: UInt64, element: Element, continuation: CheckedContinuation<Void, any Error>)] = []
  private var receivers: [CheckedContinuation<Element?, Never>] = []
  private var finished = false
  private var nextID: UInt64 = 0
  public let capacity: Int

  public init(capacity: Int) {
    precondition(capacity >= 1, "a bounded channel holds at least one element")
    self.capacity = capacity
  }

  /// Elements waiting in the buffer.
  public var count: Int { buffer.count - head }

  /// Adds `element`; suspends while the channel is full. Throws CancellationError when the sending task is cancelled
  /// while it waits, ChannelClosed after `finish()`.
  public func send(_ element: Element) async throws {
    try Task.checkCancellation()
    if finished { throw ChannelClosed() }
    if !receivers.isEmpty {
      receivers.removeFirst().resume(returning: element)
      return
    }
    if count < capacity && senders.isEmpty {
      buffer.append(element)
      return
    }
    nextID &+= 1
    let id = nextID
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
        if Task.isCancelled {
          c.resume(throwing: CancellationError())
        } else {
          senders.append((id, element, c))
        }
      }
    } onCancel: {
      Task { await self.cancelSender(id) }
    }
  }

  /// The next element in order; nil once the channel is finished and empty.
  public func next() async -> Element? {
    if count > 0 {
      let e = buffer[head]
      head += 1
      if head > 64 && head * 2 > buffer.count {
        buffer.removeFirst(head)
        head = 0
      }
      admitWaitingSender()
      return e
    }
    if !senders.isEmpty {
      let s = senders.removeFirst()
      s.continuation.resume()
      return s.element
    }
    if finished { return nil }
    return await withCheckedContinuation { receivers.append($0) }
  }

  /// No more elements: waiting receivers get nil once the buffer is drained; waiting senders throw ChannelClosed.
  public func finish() {
    finished = true
    if count == 0 {
      for r in receivers { r.resume(returning: nil) }
      receivers.removeAll()
    }
    for s in senders { s.continuation.resume(throwing: ChannelClosed()) }
    senders.removeAll()
  }

  private func admitWaitingSender() {
    guard !senders.isEmpty, count < capacity else { return }
    let s = senders.removeFirst()
    buffer.append(s.element)
    s.continuation.resume()
  }

  private func cancelSender(_ id: UInt64) {
    guard let k = senders.firstIndex(where: { $0.id == id }) else { return }
    senders.remove(at: k).continuation.resume(throwing: CancellationError())
  }
}
