// OWNER: N0
// LiveAtlas on an empty atlas in a temporary root: it opens (probe, schema, device profile, seeded vocab), answers
// health and the jobs API in the contract's shapes, journals user writes ahead of the transaction, announces data and
// journal changes, and says NOT_IMPLEMENTED for every area not ported yet (listed in Reports/live-atlas-coverage.json
// when Tools/check.sh passes SCROLLS_REPORTS_DIR).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsService
import ScrollsStore
import Testing

private func openTemporaryAtlas() async throws -> (LiveAtlas, URL) {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-liveatlas-\(UUID().uuidString)")
  let location = try AtlasLocation.at(root: root)
  let atlas = try await LiveAtlas.open(location, conditions: Unthrottled(), launch: .cli)
  return (atlas, root)
}

private func roundTrips<T: Encodable>(_ value: T, as shape: String) throws -> Bool {
  let json = try ScrollsJSON.value(value)
  return CanonicalJSON.string(try ContractCatalog.roundTrip(shape: shape, json)) == CanonicalJSON.string(json)
}

@Suite("LiveAtlas", .serialized)
struct LiveAtlasTests {
  @Test("opens an empty atlas and answers health in the contract's shape")
  func health() async throws {
    let (atlas, root) = try await openTemporaryAtlas()
    defer { try? FileManager.default.removeItem(at: root) }
    let h = try await atlas.health()
    #expect(h.ok)
    #expect(h.contract == Contract.version)
    #expect(h.jobs == HealthJobs(running: 0, queued: 0))
    #expect(h.readPool.size == 3)
    #expect(h.cipher.status == "absent", "the CLI has no bundled Cipher packs")
    #expect(h.dbBytes > 0)
    #expect(try roundTrips(h, as: "Health"))
    #expect(atlas.profile == .device)
    await atlas.close()
  }

  @Test("the jobs API: an empty list, unknown ids, a bad status filter")
  func jobsAPI() async throws {
    let (atlas, root) = try await openTemporaryAtlas()
    defer { try? FileManager.default.removeItem(at: root) }
    let list = try await atlas.jobs(JobsRequest())
    #expect(list.items.isEmpty)
    #expect(list.$cursor == .null, "the reference writes cursor: null")
    #expect(try roundTrips(list, as: "JobList"))
    await #expect(throws: ScrollsError.notFound("Job 999")) { try await atlas.job(JobID(rawValue: 999)) }
    #expect(try await atlas.cancelJob(JobID(rawValue: 999)).status == "not_found")
    do {
      _ = try await atlas.jobs(JobsRequest(status: "bogus"))
      Issue.record("an unknown status is refused")
    } catch let e as ScrollsError {
      #expect(e.code == .badStatus && e.status == 400)
    }
    await #expect(throws: ScrollsError.self) { try await atlas.jobs(JobsRequest(limit: 0)) }
    await #expect(throws: ScrollsError.self) { try await atlas.jobs(JobsRequest(cursor: "%%not a cursor")) }
    await atlas.close()
  }

  @Test("UserWrites appends to the journal before the transaction and records it as applied")
  func journaledWrite() async throws {
    let (atlas, root) = try await openTemporaryAtlas()
    defer { try? FileManager.default.removeItem(at: root) }
    var events = atlas.events.makeAsyncIterator()
    let seq = try await atlas.userWrites.perform(.viewDelete(slug: "nothing"), actor: "test") { tx, entry in
      try tx.bumpDataVersion()
      return entry.seq
    }
    #expect(seq == 1)
    #expect(await atlas.journal.head == 1)
    let applied = try await atlas.read { c in try Meta.get(c, "journal_applied_seq") }
    #expect(applied == "1")
    var sawJournal = false, sawData = false
    while !(sawJournal && sawData), let e = await events.next() {
      if case .journal(1) = e { sawJournal = true }
      if case .dataChanged(let v) = e, v >= 1 { sawData = true }
    }
    #expect(sawJournal && sawData)
    // a failed apply rolls back, but the act stays in the journal for the catch-up to apply again
    await #expect(throws: ScrollsError.self) {
      try await atlas.userWrites.perform(.viewDelete(slug: "fails"), actor: "test") { _, _ in
        throw ScrollsError.badRequest(.validation, "refused")
      }
    }
    #expect(await atlas.journal.head == 2)
    #expect(try await atlas.read { c in try Meta.get(c, "journal_applied_seq") } == "1")
    await atlas.close()
  }

  @Test("areas not ported yet answer NOT_IMPLEMENTED (501); health and the jobs API are implemented")
  func coverage() async throws {
    let (atlas, root) = try await openTemporaryAtlas()
    defer { try? FileManager.default.removeItem(at: root) }
    var pending: [String] = []
    var answered: [String] = []
    for service in ContractCatalog.endpoints.map(\.service) {
      do {
        _ = try await call(atlas, service)
        answered.append(service)
      } catch let e as ScrollsError where e.code == .notImplemented {
        #expect(e.status == 501)
        pending.append(service)
      } catch {
        answered.append(service)  // implemented, and refused the placeholder arguments
      }
    }
    for implemented in ["health", "events", "jobs", "job", "jobEvents", "cancelJob"] {
      #expect(answered.contains(implemented), "\(implemented) is implemented")
    }
    #expect(answered.count + pending.count == 65)
    if let dir = ProcessInfo.processInfo.environment["SCROLLS_REPORTS_DIR"] {
      let report: JSONValue = ["answered": .array(answered.map(JSONValue.string)), "pending": .array(pending.map(JSONValue.string)),
                               "missing_tasks": .array(TaskRegistry.missing.map(JSONValue.string))]
      try Data(CanonicalJSON.string(report).utf8).write(to: URL(fileURLWithPath: dir).appendingPathComponent("live-atlas-coverage.json"))
    }
    await atlas.close()
  }

  @Test("with no atlas and no bundled starter, opening says NOT_IMPLEMENTED (the app then serves the fixtures and says why)")
  func noStarter() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-liveatlas-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let location = try AtlasLocation.at(root: root)
    do {
      _ = try await LiveAtlas.open(location, conditions: Unthrottled(), launch: EngineLaunchOptions())
      Issue.record("opening without an atlas or a starter must not invent one")
    } catch let e as ScrollsError {
      #expect(e.code == .notImplemented && e.status == 501)
      #expect(e.message.contains("starter"))
    }
    #expect(!FileManager.default.fileExists(atPath: location.atlasPath), "nothing was created")
  }

  @Test("the list cursor is base64url of its JSON, as the reference's router encodes it")
  func paging() throws {
    let c = Paging.encodeCursor(["before": 42])
    #expect(c == "eyJiZWZvcmUiOjQyfQ")
    #expect(try Paging.decodeCursor(c)?["before"] == 42)
    #expect(try Paging.decodeCursor(nil) == nil)
    #expect(try Paging.limit(nil) == 50)
    #expect(try Paging.limit(500) == 200)
  }
}
