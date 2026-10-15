// OWNER: N0
// LiveAtlas: the engine behind AtlasService and AtlasPlatform (IOS-SPEC §1.6, §8.4.6). A final class with immutable
// stored properties; every method is `@concurrent`, so no work runs on the caller's actor (the main actor in the app).
// The routes of the reference become one `LiveAtlas+<Area>.swift` per route file, owned by the package that ports the
// area (§8.1). N0 wrote each of those files as a stub with the exact AtlasService signatures, answering
// `NOT_IMPLEMENTED` (501); the owning package replaces the bodies in its own file, so this file never changes when an
// area lands. ScrollsServiceTests list the methods that still answer NOT_IMPLEMENTED (Reports/live-atlas-coverage.json).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// How the engine was launched: the app maps its launch arguments onto this; the CLI uses `.cli`.
public struct EngineLaunchOptions: Sendable, Equatable {
  /// `-perf`: signposts and the perf log.
  public var perf: Bool
  /// `-selftest <suite>`: the suite the app is running (the engine never starts automatic jobs during one).
  public var selfTest: String?
  /// Where `starter.atlas` and the Cipher packs ship (the app bundle's Resources/Bundled); nil in the CLI.
  public var bundledResources: URL?
  /// The probe's sample books (`<name>.txt` + `<name>.sentences.sha256`, the app bundle's Probe/); nil skips the
  /// sentence check (the CLI passes `--texts`).
  public var probeSamples: URL?
  /// Start Cipher phase A when the atlas needs it and a task for it is registered (§3.6).
  public var startBootstrap: Bool
  /// The store profile; nil detects it (a new or device atlas is `.device`, a reference database stays `.reference`).
  public var profile: StoreProfile?
  /// With no atlas and no bundled starter, create an empty one (schema, device profile, seeded vocab) instead of
  /// answering NOT_IMPLEMENTED: the CLI and tests.
  public var createIfMissing: Bool

  public init(perf: Bool = false, selfTest: String? = nil, bundledResources: URL? = nil, probeSamples: URL? = nil,
              startBootstrap: Bool = true, profile: StoreProfile? = nil, createIfMissing: Bool = false) {
    self.perf = perf
    self.selfTest = selfTest
    self.bundledResources = bundledResources
    self.probeSamples = probeSamples
    self.startBootstrap = startBootstrap
    self.profile = profile
    self.createIfMissing = createIfMissing
  }

  /// The CLI: no bundle, no automatic jobs, an empty atlas when there is none.
  public static let cli = EngineLaunchOptions(startBootstrap: false, createIfMissing: true)
}

/// The live engine on one atlas root.
public final class LiveAtlas: AtlasService, AtlasPlatform {
  public let location: AtlasLocation
  public let launch: EngineLaunchOptions
  public let conditions: any DeviceConditionsSource
  public let profile: StoreProfile
  public let reads: ReadPool
  public let writer: Writer
  public let text: any TextStore
  public let journal: JournalFile
  public let jobQueue: JobQueue
  public let userWrites: UserWrites
  public let hub: AtlasEventHub
  /// Minted per launch; it feeds `compare_log` only (ΔS-1: the web's X-Scrolls-Session).
  public let session: String
  /// The probe run at open.
  public let probeReport: ProbeReport
  private let pumps: [Task<Void, Never>]

  private init(location: AtlasLocation, launch: EngineLaunchOptions, conditions: any DeviceConditionsSource,
               profile: StoreProfile, reads: ReadPool, writer: Writer, text: any TextStore, journal: JournalFile,
               jobQueue: JobQueue, hub: AtlasEventHub, probeReport: ProbeReport, pumps: [Task<Void, Never>]) {
    self.location = location
    self.launch = launch
    self.conditions = conditions
    self.profile = profile
    self.reads = reads
    self.writer = writer
    self.text = text
    self.journal = journal
    self.jobQueue = jobQueue
    self.hub = hub
    self.session = UUID().uuidString
    self.probeReport = probeReport
    self.pumps = pumps
    self.userWrites = UserWrites(journal: journal, writer: writer) { [hub] seq in hub.send(.journal(seq)) }
  }

  deinit { for p in pumps { p.cancel() } }

  /// Opens the atlas of `location`: probe → starter clone if there is no atlas yet → schema (and device profile) →
  /// `quick_check(100)` → readers, writer, text store, journal, job queue → interrupted jobs recovered.
  /// Throws `E_PROBE_REFUSED` when this phone's SQLite or ICU differs from the build's, `E_INTEGRITY_FAILED` when the
  /// atlas fails its check, and `NOT_IMPLEMENTED` when there is no atlas and no starter to clone.
  @concurrent
  public static func open(_ location: AtlasLocation, conditions: any DeviceConditionsSource,
                          launch: EngineLaunchOptions) async throws -> LiveAtlas {
    EngineAssert.offMain()
    let path = location.atlasPath
    let missing = !FileManager.default.fileExists(atPath: path)
    // The sentence samples are hashed when an atlas is first made here (segmentation is about to start); every later
    // open re-checks SQLite and FTS only, which keeps launch inside its first-frame budget.
    let report = Probe.run(sampleTexts: missing ? launch.probeSamples : nil, measureVM: false)
    guard report.passed else {
      throw ScrollsError(code: .probeRefused,
                         message: "This phone's SQLite tokenizes differently from the one Scrolls was built against (\(report.failures)). Nothing was changed.",
                         hint: "Diagnostics shows every check of the probe.", status: 500)
    }
    if missing && !launch.createIfMissing { try cloneStarter(into: location, launch: launch) }

    let profile = try prepare(path: path, wanted: launch.profile)
    let reads = try ReadPool(path: path, profile: profile)
    let writer: Writer
    do { writer = try Writer(path: path, profile: profile) } catch {
      await reads.close()
      throw error
    }
    let text: any TextStore = profile == .device ? ChunkedTextStore() : InlineTextStore()
    let journal: JournalFile, jobQueue: JobQueue
    do {
      journal = try JournalFile(directory: location.notebookDir)
      jobQueue = JobQueue(reads: reads, writer: writer, text: text, registry: TaskRegistry.all, conditions: conditions,
                          journal: journal)
      try await jobQueue.recoverInterrupted()
      if missing && launch.createIfMissing {
        try await writer.write("seed vocab") { tx in try SeedVocab.seed(tx) }
      }
    } catch {
      await reads.close()
      try? await writer.close()
      throw error
    }

    // The journal catch-up (JournalReplayer, N6) joins here as it lands; until then an atlas opens as its committed state.
    let hub = AtlasEventHub()
    await writer.setCommitObserver { [hub] version in hub.send(.dataChanged(version)) }
    let pumps = [jobEventPump(jobQueue, hub), thermalPump(conditions, hub)]
    let atlas = LiveAtlas(location: location, launch: launch, conditions: conditions, profile: profile, reads: reads,
                          writer: writer, text: text, journal: journal, jobQueue: jobQueue, hub: hub, probeReport: report,
                          pumps: pumps)
    // Cipher's bootstrap (N2 request #2, §3.6): the phases this atlas still needs are queued one after another. It
    // returns at once, and does nothing without the bundled cipher-meta pack; never during a self-test or UI tests.
    if launch.startBootstrap && launch.selfTest == nil { await BootstrapCipher.start(atlas) }
    return atlas
  }

  /// Stops the pumps, suspends jobs and closes the readers and the writer (a generation swap, the CLI's exit).
  @concurrent
  public func close() async {
    for p in pumps { p.cancel() }
    await jobQueue.suspendAll(within: .seconds(5))
    hub.finish()
    await reads.close()
    try? await writer.close()
  }

  public var events: AsyncStream<AtlasEvent> { hub.stream() }

  // MARK: opening

  /// Copies the bundled starter (`starter.atlas`: an atlas file, or a directory holding `atlas.sqlite`) into place.
  private static func cloneStarter(into location: AtlasLocation, launch: EngineLaunchOptions) throws {
    let fm = FileManager.default
    guard let starter = launch.bundledResources?.appendingPathComponent("starter.atlas"), fm.fileExists(atPath: starter.path)
    else {
      throw ScrollsError.notImplemented(
        area: "The starter atlas (no atlas at \(location.atlasPath) and no bundled starter.atlas; Tools/packs.sh builds it)")
    }
    var isDirectory: ObjCBool = false
    _ = fm.fileExists(atPath: starter.path, isDirectory: &isDirectory)
    let source = isDirectory.boolValue ? starter.appendingPathComponent("atlas.sqlite") : starter
    // copyItem clones on APFS (clonefile) and copies elsewhere
    try fm.copyItem(at: source, to: URL(fileURLWithPath: location.atlasPath))
  }

  /// Brings the schema current (adding the device profile to a device atlas) and runs `quick_check(100)`; returns the
  /// profile the atlas is opened with.
  private static func prepare(path: String, wanted: StoreProfile?) throws -> StoreProfile {
    let probe = try Connection(path: path, mode: .readWrite, profile: .reference)
    let isNew = try Migrations.currentVersion(probe) == 0
    let profile = try wanted ?? (isNew || Migrations.hasDeviceProfile(probe) ? .device : .reference)
    probe.close()
    let c = try Connection(path: path, mode: .readWrite, profile: profile)
    defer { c.close() }
    try Migrations.migrate(c)
    let check = try Integrity.quickCheck(c, limit: 100)
    guard check.ok else {
      throw ScrollsError(code: .integrityFailed, message: "The atlas failed its integrity check: \(check.messages.joined(separator: "; "))",
                         hint: "Diagnostics → Roll back to the previous atlas, or rebuild it; your notebook is kept.",
                         detail: .array(check.messages.map(JSONValue.string)), status: 500)
    }
    return profile
  }

  /// JobQueue events → the `job` channel.
  private static func jobEventPump(_ queue: JobQueue, _ hub: AtlasEventHub) -> Task<Void, Never> {
    let events = queue.events
    return Task {
      for await e in events {
        if Task.isCancelled { return }
        hub.send(.job(JobEventPayload(e)))
      }
    }
  }

  /// The compute throttle, sampled every two seconds; a change goes out as `.thermal`.
  private static func thermalPump(_ conditions: any DeviceConditionsSource, _ hub: AtlasEventHub) -> Task<Void, Never> {
    Task {
      var last = conditions.current
      hub.send(.thermal(last))
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(2))
        let now = conditions.current
        if now != last {
          last = now
          hub.send(.thermal(now))
        }
      }
    }
  }

  // MARK: shared helpers for the LiveAtlas+<Area> files

  /// One interactive read on its own WAL snapshot (§1.4), with the 5 s deadline.
  public func read<T: Sendable>(_ body: @Sendable (Connection) throws -> T) async throws -> T {
    try await reads.read(.interactive, deadline: .seconds(5), body)
  }

  // MARK: AtlasPlatform (the parts LiveAtlas owns; packs, inbox, generations and storage are LivePlatform's, N2)

  /// The probe on this device. A `-selftest probe` run also maps the 256 MB windows (the VM row of §3.8), which the
  /// probe at open skips because it takes seconds.
  @concurrent
  public func probe() async -> ProbeReport {
    Probe.run(sampleTexts: launch.probeSamples, measureVM: launch.selfTest == "probe")
  }

  @concurrent
  public func trim() async {
    // Each reader drops its page cache and its decoded-chunk LRU; the tile and memo caches register here as they land.
    await reads.trim()
  }

  @concurrent
  public func replayStatus() async -> ReplayReport? { nil }

  @concurrent
  public func runSelfTest(_ suite: String) async throws -> [ProbeCheck] {
    switch suite {
    case "probe": return await probe().checks
    default: return [ProbeCheck(name: suite, status: .skip, detail: "the engine has no steps of its own for this suite yet")]
    }
  }

  @concurrent
  public func diagnostics() async throws -> DiagnosticsReport {
    let (version, applied, generation) = try await read { c in
      (try Meta.dataVersion(c), UInt64(try Meta.get(c, "journal_applied_seq") ?? "0") ?? 0, try Meta.get(c, "generation"))
    }
    return DiagnosticsReport(engineVersion: BuildInfo.engineVersion, generation: generation, journalHead: await journal.head,
                             journalAppliedSeq: applied, dataVersion: version, probe: probeReport)
  }

  /// Background: from now on only jobs that may start in the background are admitted (§3.7); the running ones commit
  /// their chunk and stop, then a PASSIVE checkpoint runs, so no transaction is held across suspension.
  @concurrent
  public func suspendJobs(within limit: Duration) async {
    await jobQueue.setForeground(false)
    await jobQueue.suspendAll(within: limit)
    _ = try? await writer.checkpoint(.passive)
  }

  /// Foreground again: every job may start, and the suspended ones are queued again.
  @concurrent
  public func resumeJobs() async {
    await jobQueue.setForeground(true)
    await jobQueue.resumeAll()
  }
}

// MARK: - list paging (the reference's router.mjs helpers, shared by every list route)

/// `limit` and opaque `cursor` of list endpoints, as the reference encodes them.
public enum Paging {
  /// `limit` clamped to [1, max]; nil gives `defaultLimit`. Throws E_BAD_LIMIT for a non-positive limit.
  public static func limit(_ value: Int?, max: Int = 200, default defaultLimit: Int = 50) throws -> Int {
    guard let value else { return Swift.min(defaultLimit, max) }
    guard value >= 1 else {
      throw ScrollsError.badRequest(.badLimit, "limit must be a positive integer (got '\(value)').", hint: "Use 1–\(max).")
    }
    return Swift.min(value, max)
  }

  /// `encodeCursor`: base64url (no padding) of the cursor object's JSON.
  public static func encodeCursor(_ cursor: JSONObject) -> String {
    Data(CanonicalJSON.string(.object(cursor)).utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// `decodeCursor`: nil for no cursor; E_BAD_CURSOR for one this engine did not issue.
  public static func decodeCursor(_ s: String?) throws -> JSONObject? {
    guard let s, !s.isEmpty else { return nil }
    var b64 = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    if let data = Data(base64Encoded: b64), case .object(let o)? = try? JSONValue.parse(data) { return o }
    throw ScrollsError.badRequest(.badCursor, "The cursor is not one this server issued.",
                                  hint: "Restart the list without a cursor.")
  }
}
