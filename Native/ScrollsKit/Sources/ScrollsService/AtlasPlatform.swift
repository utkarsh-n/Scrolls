// OWNER: N0
// Phone-only operations (IOS-SPEC §1.6, §8.4.6): packs, the inbox, generations, storage, the probe, self-test steps,
// diagnostics and the app's lifecycle hooks. Not part of contract 1.3.0; versioned P1 and additive. LivePlatform
// (N2) implements the pack, inbox and generation parts; LiveAtlas the rest.

import Foundation
import ScrollsContracts
import ScrollsStore

/// The P1 version of the platform surface.
public enum PlatformVersion {
  public static let current = "P1"
}

/// What the phone can do beyond contract 1.3.0.
public protocol AtlasPlatform: Sendable {
  /// The SQLite, FTS, sentence-break, font, NL, memory and VM checks (§1.4, §3.8).
  func probe() async -> ProbeReport
  /// Installed and inbox packs with their verification state.
  func packs() async throws -> [PackStatus]
  /// Verifies a pack and moves it into Atlas/packs; loading it is `AtlasService.loadAdapter`.
  func installPack(_ url: URL) async throws -> PackStatus
  /// What waits in the drop folders, Documents/Import then the system's Documents/Inbox (packs, atlases, import files);
  /// a name in both is listed once, from Import.
  func inbox() async throws -> [InboxItem]
  /// The current, next and previous generations.
  func generations() async throws -> GenerationsStatus
  /// Installs a `.scrollsatlas` / `.scrollsarchive` (§3.5 steps 1–7) as a job.
  func installGeneration(_ url: URL) async throws -> JobID
  /// Swaps back to `Atlas.prev` (one step).
  func rollbackGeneration() async throws
  /// Replays the starter, packs and journal into `Atlas.next`, then swaps.
  func rebuildGeneration() async throws -> JobID
  /// The measured storage of the container (§3.1).
  func storage() async throws -> StorageReport
  /// Deletes purgeable caches (cubes, token streams, tiles, thumbnails).
  func purgeCaches() async throws
  /// Memory warning: drops the tile and memo LRUs and the chunk caches.
  func trim() async
  /// The last journal replay (launch catch-up, restore or generation build); nil before any.
  func replayStatus() async -> ReplayReport?
  /// The engine's steps of a self-test suite ('probe', 'first-minute', …), as check rows.
  func runSelfTest(_ suite: String) async throws -> [ProbeCheck]
  /// Engine facts for Settings → Diagnostics.
  func diagnostics() async throws -> DiagnosticsReport
  /// The scene is going to the background: the running chunk commits, jobs stop, a PASSIVE checkpoint runs (§3.7).
  func suspendJobs(within limit: Duration) async
  /// The scene is active again: suspended jobs resume.
  func resumeJobs() async
}

/// A pack as the Sources page lists it.
public struct PackStatus: Codable, Sendable, Equatable {
  /// Where it is (`inbox`: waiting in a drop folder, Import or the system Inbox; `folder` says which).
  public enum Location: String, Codable, Sendable { case bundled, inbox, installed }
  /// How far its verification got.
  public enum Verification: String, Codable, Sendable { case unverified, verifying, verified, failed }

  public var name: String
  public var version: String
  public var sha256: String?
  public var bytes: Int64
  public var location: Location
  public var verification: Verification
  /// Whether its sources are loaded into the current generation.
  public var loaded: Bool
  /// Why it cannot be installed or loaded, in words.
  public var problem: String?
  /// For a pack waiting to be installed (`location == .inbox`): the drop folder it waits in.
  public var folder: DropFolder?

  public init(name: String, version: String, sha256: String? = nil, bytes: Int64, location: Location,
              verification: Verification, loaded: Bool, problem: String? = nil, folder: DropFolder? = nil) {
    self.name = name
    self.version = version
    self.sha256 = sha256
    self.bytes = bytes
    self.location = location
    self.verification = verification
    self.loaded = loaded
    self.problem = problem
    self.folder = folder
  }
}

/// The two folders where packs, atlases and import files wait (§3.5, §3.9), in listing order.
public enum DropFolder: String, Codable, Sendable, CaseIterable {
  /// Documents/Import: the app's own, made at every launch (devicectl pushes; Finder, Files; DeepLinks copies a pack
  /// opened in place into it, `DropFolder.receive`).
  case `import`
  /// Documents/Inbox: the system's (AirDrop and share-sheet copies); the app reads and removes there but cannot create
  /// or write it, so it may be missing.
  case inbox

  /// The folder's directory in `location`.
  public func url(in location: AtlasLocation) -> URL {
    switch self {
    case .import: location.importDir
    case .inbox: location.inboxDir
    }
  }
}

/// A file waiting in a drop folder (Documents/Import or the system's Documents/Inbox).
public struct InboxItem: Codable, Sendable, Equatable {
  public enum Kind: String, Codable, Sendable { case pack, atlas, archive, baseline, importFile = "import", unknown }
  public var url: URL
  /// The drop folder it waits in.
  public var folder: DropFolder
  public var kind: Kind
  public var bytes: Int64
  /// Whether it can be installed here, and if not why (the mismatch copy of §3.5 step 1).
  public var compatible: Bool
  public var note: String?

  public init(url: URL, folder: DropFolder, kind: Kind, bytes: Int64, compatible: Bool, note: String? = nil) {
    self.url = url
    self.folder = folder
    self.kind = kind
    self.bytes = bytes
    self.compatible = compatible
    self.note = note
  }
}

/// One generation (its `ATLAS.json` facts).
public struct GenerationInfo: Codable, Sendable, Equatable {
  public var generation: String
  public var engineVersion: String
  public var journalSeq: UInt64
  public var builtOn: String
  public var builtAt: String
  public var bytes: Int64

  public init(generation: String, engineVersion: String, journalSeq: UInt64, builtOn: String, builtAt: String, bytes: Int64) {
    self.generation = generation
    self.engineVersion = engineVersion
    self.journalSeq = journalSeq
    self.builtOn = builtOn
    self.builtAt = builtAt
    self.bytes = bytes
  }
}

/// The current generation, the one being built or installed, and the one kept for rollback.
public struct GenerationsStatus: Codable, Sendable, Equatable {
  public var current: GenerationInfo?
  public var next: GenerationInfo?
  public var previous: GenerationInfo?
  /// The job building or installing `next`.
  public var job: JobID?

  public init(current: GenerationInfo?, next: GenerationInfo? = nil, previous: GenerationInfo? = nil, job: JobID? = nil) {
    self.current = current
    self.next = next
    self.previous = previous
    self.job = job
  }
}

/// The container's storage, measured (bytes by area) and the free space.
public struct StorageReport: Codable, Sendable, Equatable {
  /// Area → bytes (atlas, derived, packs, caches, notebook, import, inbox, exports, next, prev).
  public var areas: [String: Int64]
  /// `volumeAvailableCapacityForImportantUsage`.
  public var availableBytes: Int64
  public init(areas: [String: Int64], availableBytes: Int64) {
    self.areas = areas
    self.availableBytes = availableBytes
  }
}

/// The result of a journal replay (§6.5): acts resolved, re-anchored, orphaned, and what the replay waits for.
public struct ReplayReport: Codable, Sendable, Equatable {
  public var fromSeq: UInt64
  public var toSeq: UInt64
  public var resolved: Int
  public var reanchored: Int
  /// Acts whose anchor no longer resolves: kept as orphaned interpretations, never dropped.
  public var orphaned: Int
  /// The op the replay stopped at for a missing input (a pack or an original), with the reason in words.
  public var waiting: ReplayWait?

  public init(fromSeq: UInt64, toSeq: UInt64, resolved: Int, reanchored: Int, orphaned: Int, waiting: ReplayWait? = nil) {
    self.fromSeq = fromSeq
    self.toSeq = toSeq
    self.resolved = resolved
    self.reanchored = reanchored
    self.orphaned = orphaned
    self.waiting = waiting
  }
}

/// Where a replay waits and why ("Your notebook refers to the STEMM pack … 12 later actions wait for it.").
public struct ReplayWait: Codable, Sendable, Equatable {
  public var seq: UInt64
  public var reason: String
  /// Acts after it that wait too.
  public var waitingActs: Int
  public init(seq: UInt64, reason: String, waitingActs: Int) {
    self.seq = seq
    self.reason = reason
    self.waitingActs = waitingActs
  }
}

/// Engine facts for Diagnostics: versions, the generation, the journal head, the probe and the last fingerprint check.
public struct DiagnosticsReport: Codable, Sendable, Equatable {
  public var engineVersion: String
  public var contract: String
  public var platform: String
  public var generation: String?
  public var journalHead: UInt64
  public var journalAppliedSeq: UInt64
  public var dataVersion: Int
  public var probe: ProbeReport?
  /// The G6 comparison with the CLI's fingerprint, when one was run: 'PASS' | 'FAIL' and the tables that differ.
  public var fingerprint: String?

  public init(engineVersion: String, contract: String = Contract.version, platform: String = PlatformVersion.current,
              generation: String?, journalHead: UInt64, journalAppliedSeq: UInt64, dataVersion: Int, probe: ProbeReport? = nil,
              fingerprint: String? = nil) {
    self.engineVersion = engineVersion
    self.contract = contract
    self.platform = platform
    self.generation = generation
    self.journalHead = journalHead
    self.journalAppliedSeq = journalAppliedSeq
    self.dataVersion = dataVersion
    self.probe = probe
    self.fingerprint = fingerprint
  }
}
