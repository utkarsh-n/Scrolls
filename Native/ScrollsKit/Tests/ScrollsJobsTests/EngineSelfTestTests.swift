// OWNER: N0
// The engine self-test the app runs on the device (`-selftest probe` and `perf`): every row passes on the Mac, so a
// device FAIL is a device finding, not a broken check.

import Foundation
import ScrollsJobs
import ScrollsStore
import Testing

@Suite("Engine self-test (device rows)", .serialized)
struct EngineSelfTestTests {
  @Test("acknowledgements, the deadline and chunk decode pass in a scratch atlas, which is deleted afterwards")
  func acknowledgements() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-engine-selftest-test-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let checks = await EngineSelfTest.acknowledgements(in: dir, sample: nil)
    #expect(checks.map(\.name) == ["store.read_interrupt", "store.deadline", "jobs.cancel.compute_loop",
                                   "jobs.cancel.running_statement", "store.chunk_decode"])
    for c in checks { #expect(c.status == .pass, "\(c.name): \(c.detail)") }
    #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty)
  }

  @Test("the stall rule over a 4 s statement: at least 2 increments, none 2 s apart")
  func stallRule() async throws {
    let checks = await EngineSelfTest.stallRule(in: FileManager.default.temporaryDirectory, seconds: 4)
    #expect(checks.count == 1)
    #expect(checks.first?.status == .pass, "\(checks.first?.detail ?? "")")
  }
}
