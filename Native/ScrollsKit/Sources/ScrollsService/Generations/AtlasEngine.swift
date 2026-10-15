// OWNER: N2
// The engine pieces of one atlas root without the AtlasService surface: the readers, the writer, the text store, the
// journal and a job queue whose registry includes the source-load tasks (IOS-SPEC §3.5 "generations", §3.6). It is what
// builds atlases by replaying inputs — `scrolls-cli starter` and `atlas build`, the self-test bootstrap on the phone, and
// the tests — so those never depend on which task types the app's LiveAtlas registers. Opening follows LiveAtlas.open:
// probe, starter clone (or a new empty atlas with seeded vocab), schema + device profile, quick_check(100), then
// interrupted jobs are recovered (resumable ones re-queue from their committed rows).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsQuery
import ScrollsStore

/// The task types a generation build runs: the app's registry plus the source loads (deduplicated by type).
public enum SourceTasks {
  /// N2's job types.
  public static let all: [any JobTask.Type] = [AdapterLoadTask.self, DemoLoadTask.self, BootstrapCipherTask.self]

  /// `TaskRegistry.all` plus N2's tasks and the demo pipeline's materialize step.
  public static var registry: [any JobTask.Type] {
    var seen = Set<String>(), out: [any JobTask.Type] = []
    for t in TaskRegistry.all + all + [MaterializeTask.self] where seen.insert(t.type.rawValue).inserted { out.append(t) }
    return out
  }
}

/// One atlas root opened for building.
public final class AtlasEngine: Sendable {
  public let location: AtlasLocation
  public let reads: ReadPool
  public let writer: Writer
  public let text: any TextStore
  public let journal: JournalFile
  public let jobs: JobQueue
  public let profile: StoreProfile

  private init(location: AtlasLocation, reads: ReadPool, writer: Writer, text: any TextStore, journal: JournalFile,
               jobs: JobQueue, profile: StoreProfile) {
    self.location = location
    self.reads = reads
    self.writer = writer
    self.text = text
    self.journal = journal
    self.jobs = jobs
    self.profile = profile
  }

  /// How a missing atlas is made.
  public enum Origin: Sendable {
    /// Clone this starter (`starter.atlas`: a directory holding atlas.sqlite, or the file itself).
    case starter(URL)
    /// A new, empty device atlas with the seeded vocabulary (what `scrolls-cli starter` starts from).
    case empty
    /// The atlas must exist.
    case existing
  }

  /// Opens (or makes) the atlas of `location`.
  public static func open(_ location: AtlasLocation, origin: Origin, conditions: any DeviceConditionsSource = Unthrottled(),
                          registry: [any JobTask.Type] = SourceTasks.registry) async throws -> AtlasEngine {
    let fm = FileManager.default
    let path = location.atlasPath
    let missing = !fm.fileExists(atPath: path)
    if missing {
      switch origin {
      case .starter(let url): try cloneStarter(url, to: location)
      case .empty: break
      case .existing:
        throw ScrollsError(code: .validation, message: "No atlas at \(path).", hint: "Build one first.", status: 404)
      }
    }
    let probe = try Connection(path: path, mode: .readWrite, profile: .reference)
    let isNew = try Migrations.currentVersion(probe) == 0
    let profile: StoreProfile = try isNew || Migrations.hasDeviceProfile(probe) ? .device : .reference
    probe.close()
    do {
      let c = try Connection(path: path, mode: .readWrite, profile: profile)
      defer { c.close() }
      try Migrations.migrate(c)
      let check = try Integrity.quickCheck(c, limit: 100)
      guard check.ok else {
        throw ScrollsError(code: .integrityFailed, message: "The atlas failed its integrity check: \(check.messages.joined(separator: "; "))",
                           hint: "Build it again.", status: 500)
      }
    }
    let reads = try ReadPool(path: path, profile: profile)
    let writer: Writer
    do { writer = try Writer(path: path, profile: profile) } catch {
      await reads.close()
      throw error
    }
    do {
      let text: any TextStore = profile == .device ? ChunkedTextStore() : InlineTextStore()
      let journal = try JournalFile(directory: location.notebookDir)
      let jobs = JobQueue(reads: reads, writer: writer, text: text, registry: registry, conditions: conditions, journal: journal)
      try await writer.write("seed vocab") { tx in try SeedVocab.seed(tx) }
      try await jobs.recoverInterrupted()
      return AtlasEngine(location: location, reads: reads, writer: writer, text: text, journal: journal, jobs: jobs,
                         profile: profile)
    } catch {
      await reads.close()
      try? await writer.close()
      throw error
    }
  }

  /// Copies a starter into place (APFS clone through copyItem; a copy elsewhere).
  static func cloneStarter(_ starter: URL, to location: AtlasLocation) throws {
    let fm = FileManager.default
    var isDirectory: ObjCBool = false
    guard fm.fileExists(atPath: starter.path, isDirectory: &isDirectory) else {
      throw ScrollsError(code: .validation, message: "No starter at \(starter.path).",
                         hint: "Tools/packs.sh starter builds it.", status: 404)
    }
    let source = isDirectory.boolValue ? starter.appendingPathComponent("atlas.sqlite") : starter
    try fm.copyItem(at: source, to: URL(fileURLWithPath: location.atlasPath))
  }

  /// Queues `spec` and waits until the job ends; a job that suspends with the app or times out answers its last state.
  public func run(_ spec: JobSpec, timeout: Duration = .seconds(3 * 3600)) async throws -> JobSnapshot {
    let id = try await jobs.enqueue(spec)
    let deadline = ContinuousClock.now + timeout
    while true {
      let left = deadline - ContinuousClock.now
      guard left > .zero else { break }
      if let snap = await jobs.wait(for: id, timeout: min(left, .seconds(600))), snap.status.isFinal { return snap }
      try Task.checkCancellation()
    }
    guard let snap = try await jobs.job(id) else {
      throw ScrollsError(code: .validation, message: "Job \(id.rawValue) vanished.", hint: "", status: 500)
    }
    return snap
  }

  /// One read on the interactive lane.
  public func read<T: Sendable>(_ body: @Sendable (Connection) throws -> T) async throws -> T {
    try await reads.read(.interactive, deadline: .seconds(60), body)
  }

  /// Stops the queue (the running job commits its chunk), checkpoints the WAL into the file, closes everything.
  public func close() async {
    await jobs.suspendAll(within: .seconds(5))
    _ = try? await writer.checkpoint(.truncate)
    await reads.close()
    try? await writer.close()
  }
}
