// OWNER: N2 — stub written by N0 (frozen at M0: IOS-SPEC §8.2 "SourceAdapter"; changes go through N0, additively)
// The source-adapter interface (SPEC §10.1, `server/adapters/api.mjs`): every source — the demo, Cipher, STEMM — is one
// adapter; a new source is one adapter plus its entry in `SourceRegistry`, and nothing in the core changes. Adapters
// never write SQL: a pipeline drives them into a `DocumentWriting` (ScrollsIngest). On the phone adapters read pack
// members through `PackReader` (ΔS-5, ΔS-6), never loose folders, and they parse on a producer task that sends batches
// of 500 records into a `BoundedChannel` (capacity 4), whose `send` suspends while the writer is behind (§1.5).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// A collection an adapter loads into (`CollectionSpec` of api.mjs; vocab domains, modalities, units, samplings).
public struct CollectionSpec: Sendable, Codable, Equatable {
  public var slug: String
  public var name: String
  /// literature · culture · stemm · etymology · imported · demo
  public var domain: String
  /// text · titles · abstracts · lexical · baseline
  public var modality: String
  /// tokens · works · entries · none
  public var unit: String
  /// complete · prominence_selected · top_cited_per_cell · relation_endpoints · curated · user
  public var sampling: String
  public var rateEligible: Bool?
  public var exportTextAllowed: Bool?
  public var coverageGate: Double?
  public var selectionNote: String?

  public init(slug: String, name: String, domain: String, modality: String, unit: String, sampling: String,
              rateEligible: Bool? = nil, exportTextAllowed: Bool? = nil, coverageGate: Double? = nil,
              selectionNote: String? = nil) {
    self.slug = slug
    self.name = name
    self.domain = domain
    self.modality = modality
    self.unit = unit
    self.sampling = sampling
    self.rateEligible = rateEligible
    self.exportTextAllowed = exportTextAllowed
    self.coverageGate = coverageGate
    self.selectionNote = selectionNote
  }
}

/// How an adapter reaches its data. Network adapters stay disabled (ΔS-17: the app has no networking code).
public enum AdapterAccess: String, Sendable, Codable { case localFile = "local-file", localDataset = "local-dataset", network }

/// What `probe` found (`ProbeResult` of api.mjs): it reads FORMAT.md and MANIFEST.json first.
public struct AdapterProbeResult: Sendable, Equatable {
  public var available: Bool
  /// Why it is unavailable ("unavailable: <reason>" on the Sources page).
  public var reason: String?
  public var manifestOK: Bool
  public var formatOK: Bool
  public var counts: [String: Int]
  /// Copied into `collection.caveats_json`.
  public var caveats: [String]

  public init(available: Bool, reason: String? = nil, manifestOK: Bool, formatOK: Bool, counts: [String: Int] = [:],
              caveats: [String] = []) {
    self.available = available
    self.reason = reason
    self.manifestOK = manifestOK
    self.formatOK = formatOK
    self.counts = counts
    self.caveats = caveats
  }
}

/// What an adapter may use while it runs (`AdapterCtx` of api.mjs). Cancellation is the task's.
public struct AdapterContext: Sendable {
  /// The pack holding the adapter's members; nil for adapters that ship as engine resources (the demo).
  public var pack: PackReader?
  /// `progress(done, total, message)`.
  public var progress: @Sendable (Int, Int, String?) -> Void
  /// `warn(code, message, detail)`: an issue that does not stop the load.
  public var warn: @Sendable (String, String, JSONValue?) -> Void

  public init(pack: PackReader?, progress: @escaping @Sendable (Int, Int, String?) -> Void = { _, _, _ in },
              warn: @escaping @Sendable (String, String, JSONValue?) -> Void = { _, _, _ in }) {
    self.pack = pack
    self.progress = progress
    self.warn = warn
  }
}

/// One source of canonical records.
public protocol SourceAdapter: Sendable {
  /// 'cipher.works', 'stemm.openalex', 'demo'.
  var id: String { get }
  /// Semver; recorded on the import batch and in `JournalOp.sourceLoad`.
  var version: String { get }
  var label: String { get }
  var access: AdapterAccess { get }
  var license: String { get }
  var attribution: String { get }
  var collections: [CollectionSpec] { get }

  /// Checks that the adapter's members are there and well-formed; reads FORMAT.md and MANIFEST.json first.
  func probe(_ context: AdapterContext) async throws -> AdapterProbeResult
  /// How many units (documents, rows) a load with `params` will process, for progress.
  func plan(_ params: JSONValue, _ context: AdapterContext) async throws -> Int
  /// Parses the documents and sends them in batches of up to 500; returns when every batch has been sent.
  func documents(_ params: JSONValue, _ context: AdapterContext,
                 into channel: BoundedChannel<[CanonicalDocument]>) async throws
  /// The relationships the source documents (none by default).
  func relationships(_ params: JSONValue, _ context: AdapterContext,
                     into channel: BoundedChannel<[CanonicalRelationship]>) async throws
  /// The annotations the source carries (none by default).
  func annotations(_ params: JSONValue, _ context: AdapterContext,
                   into channel: BoundedChannel<[CanonicalAnnotation]>) async throws
}

extension SourceAdapter {
  public func relationships(_ params: JSONValue, _ context: AdapterContext,
                            into channel: BoundedChannel<[CanonicalRelationship]>) async throws {}
  public func annotations(_ params: JSONValue, _ context: AdapterContext,
                          into channel: BoundedChannel<[CanonicalAnnotation]>) async throws {}
}
