// OWNER: N0
// AtlasEventHub: every subscriber gets every event; one job's progress is throttled; ends and other channels are not.

import Foundation
import ScrollsContracts
import ScrollsJobs
import ScrollsService
import Testing

private func progress(_ job: Int, _ phase: String?, _ f: Double) -> AtlasEvent {
  .job(.progress(JobProgressPayload(job: job, type: "cluster", phase: phase, fraction: f, message: nil)))
}

@Suite("Atlas events")
struct EventHubTests {
  @Test("two subscribers each receive every event; finish ends both streams")
  func fanOut() async {
    let hub = AtlasEventHub(minProgressInterval: .zero)
    let a = hub.stream(), b = hub.stream()
    #expect(hub.subscriberCount == 2)
    hub.send(.dataChanged(5))
    hub.send(.journal(9))
    hub.finish()
    var seenA = 0, seenB = 0
    for await _ in a { seenA += 1 }
    for await _ in b { seenB += 1 }
    #expect(seenA == 2 && seenB == 2)
  }

  @Test("progress of one job in one phase is throttled; a new phase, another job and the done event go out at once")
  func throttle() {
    let hub = AtlasEventHub(minProgressInterval: .seconds(60))
    _ = hub.stream()
    #expect(hub.send(progress(1, "bootstrap", 0.1)))
    #expect(!hub.send(progress(1, "bootstrap", 0.2)))
    #expect(hub.send(progress(1, "labels", 0.3)))
    #expect(hub.send(progress(2, "bootstrap", 0.1)))
    #expect(hub.send(.job(.done(JobDonePayload(job: 1, status: "succeeded")))))
    #expect(hub.send(progress(1, "labels", 0.4)), "a finished job's next progress is not throttled against the old one")
    #expect(hub.send(.dataChanged(3)))
  }

  @Test("a new subscriber first hears the current throttle")
  func thermalIsReplayed() async {
    let hub = AtlasEventHub()
    hub.send(.thermal(.serious))
    var it = hub.stream().makeAsyncIterator()
    guard case .thermal(let t)? = await it.next() else {
      Issue.record("the first event is the throttle")
      return
    }
    #expect(t == .serious)
  }

  @Test("a subscriber that stops listening is dropped")
  func dropsEndedSubscribers() async throws {
    let hub = AtlasEventHub()
    do {
      let s = hub.stream()
      var it = s.makeAsyncIterator()
      hub.send(.journal(1))
      _ = await it.next()
    }
    for _ in 0..<50 where hub.subscriberCount > 0 { try await Task.sleep(for: .milliseconds(10)) }
    #expect(hub.subscriberCount == 0)
  }
}
