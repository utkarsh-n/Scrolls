// OWNER: N0
// Compute fan-out (IOS-SPEC §1.5): a TaskGroup of `ctx.parallelism` workers that claim chunks of the input from one
// shared counter (work stealing) and size their chunks to ~`chunkBudget` of work, so 2 performance + 4 efficiency
// cores finish together instead of at the pace of the slowest static shard. Each chunk ends with a checkpoint.
// Accelerate calls with large operands must not run inside `f` (BLAS threads internally).

import Foundation
import Synchronization

extension JobContext {
  /// `items.map(f)` on `parallelism` workers in work-stealing chunks of ≤ `chunkBudget`; results keep input order.
  public func concurrentMap<T: Sendable, R: Sendable>(_ items: [T], chunkBudget: Duration = .milliseconds(5),
                                                       _ f: @Sendable (T) throws -> R) async throws -> [R] {
    let n = items.count
    if n == 0 { return [] }
    let workers = max(1, min(parallelism, n))
    let cursor = ChunkCursor()
    // the group finishes before this function returns, so `f` never outlives the call
    return try await withoutActuallyEscaping(f) { f in try await withThrowingTaskGroup(of: [(Int, R)].self) { group in
      for _ in 0..<workers {
        group.addTask {
          var out: [(Int, R)] = []
          var size = 1
          while true {
            let start = cursor.claim(size)
            if start >= n { break }
            let end = min(n, start + size)
            let t0 = ContinuousClock.now
            for i in start..<end { out.append((i, try f(items[i]))) }
            let elapsed = ContinuousClock.now - t0
            if elapsed * 2 < chunkBudget {
              size = min(size * 2, 1 << 16)
            } else if elapsed > chunkBudget, size > 1 {
              size /= 2
            }
            try await self.checkpoint()
          }
          return out
        }
      }
      var results = [R?](repeating: nil, count: n)
      for try await part in group {
        for (i, r) in part { results[i] = r }
      }
      return results.map { $0! }
    } }
  }
}

/// The shared claim counter of one `concurrentMap`.
final class ChunkCursor: Sendable {
  private let next = Atomic<Int>(0)
  /// Claims `size` items; returns the first index claimed.
  func claim(_ size: Int) -> Int { next.add(size, ordering: .relaxed).oldValue }
}
