// OWNER: N2
// Adapters in process (server/routes/adapters.mjs; SPEC §7.1, §10.1, ΔS-5, ΔS-6): the source adapters of this build with
// the packs they read. On the phone an adapter's "staged files" are pack members, so `available` says whether its packs
// are here and, when not, how to send them from the Mac (the app never fetches: ΔS-17).
// - adapters: every registered adapter, with its packs, licence, enabled flag and whether its collections hold documents;
// - loadAdapter: a Cipher adapter resumes the Cipher bootstrap (Cipher loads as one set, as in the reference), the demo
//   queues demo-load; STEMM loads are M2 work and answer NOT_IMPLEMENTED with what is missing, never a partial load;
// - enableAdapter and adapterClaims (Wiktionary attestation claims) are M2 work as well.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsSources
import ScrollsStore

/// The statements of the adapters route.
public enum AdaptersSQL: SQLCatalog {
  static let rows = SQL("adapters.rows", "SELECT id, enabled FROM source_adapter", scan: .scanOK(reason: "a dozen adapters"))
  static let loadedCollections = SQL("adapters.loaded", """
    SELECT c.adapter_id, EXISTS (SELECT 1 FROM document d WHERE d.collection_id = c.id AND d.deleted_at IS NULL) FROM collection c
    """, scan: .scanOK(reason: "one indexed probe per collection"))
  public static let all: [SQL] = [rows, loadedCollections]
}

extension LiveAtlas {
  /// What to run on the Mac to stage a STEMM source (the fetchers stay Node scripts, D13).
  static let fetchers = [
    "stemm.gutenberg-stemm": "node tools/fetch/gutenberg-stemm.mjs", "stemm.openalex": "node tools/fetch/openalex.mjs",
    "stemm.wiktionary": "node tools/fetch/wiktionary-coinage.mjs", "stemm.ngram": "node tools/fetch/ngram-baseline.mjs",
  ]

  @concurrent
  public func adapters(_ r: AdaptersRequest) async throws -> AdaptersResponse {
    let path = location.atlasPath
    let (enabled, loaded) = try await read { c in
      (Dictionary(try c.prepared(AdaptersSQL.rows).all { ($0.text(0), $0.int(1) != 0) }, uniquingKeysWith: { a, _ in a }),
       Dictionary(try c.prepared(AdaptersSQL.loadedCollections).all { ($0.text(0), $0.int(1) > 0) }, uniquingKeysWith: { a, b in a || b }))
    }
    return SourceRegistry.adapters.map { a in
      let packs = a.id == DemoAdapter.adapterID ? [] : SourceRegistry.packNames(for: a)
      let missing = packs.filter { PackLibrary.url(of: $0, atlasPath: path) == nil }
      let isCipher = a.id.hasPrefix("cipher.")
      let available = missing.isEmpty && (isCipher || a.id == DemoAdapter.adapterID)
      var reason: String?
      if !missing.isEmpty {
        reason = "the \(missing.joined(separator: " and ")) pack\(missing.count == 1 ? " is" : "s are") not on this phone"
      } else if !available {
        reason = "loading this source on the phone is not in this build yet"
      }
      let command: String? = isCipher || a.id == DemoAdapter.adapterID ? nil
        : [LiveAtlas.fetchers[a.id], "Tools/packs.sh stemm, then Tools/atlas.sh push-pack stemm"].compactMap { $0 }.joined(separator: " · ")
      let staged: JSONValue = packs.isEmpty ? .null
        : ["packs": .array(packs.map(JSONValue.string)), "missing": .array(missing.map(JSONValue.string))]
      let caveats = ((a as? any CollectionCaveats)?.collectionCaveats.values.flatMap { $0 } ?? []).sorted()
      return AdapterInfo(id: a.id, version: a.version, access: a.access.rawValue, staged: staged, license: a.license,
                         loaded: loaded[a.id] ?? false, label: a.label, available: available, reason: reason, command: command,
                         caveats: .array(caveats.map(JSONValue.string)), attribution: a.attribution,
                         enabled: enabled[a.id] ?? (a.access != .network), loadable: available,
                         note: isCipher ? "Cipher loads as one set: phases A (metadata), A2 (genealogy) and B (full text)." : nil)
    }
  }

  @concurrent
  public func adapterClaims(_ id: String, _ r: AdapterClaimsRequest) async throws -> AdapterClaimsResponse {
    throw ScrollsError.notImplemented(area: "Adapter claims (Wiktionary attestation claims, STEMM): M2, package N2")
  }

  @concurrent
  public func loadAdapter(_ id: String, _ r: AdapterLoadRequest) async throws -> AdapterLoadResponse {
    guard SourceRegistry.adapter(id: id) != nil else {
      throw ScrollsError(code: ErrorCode(rawValue: "E_ADAPTER_UNKNOWN"), message: "Unknown adapter '\(id)'.",
                         hint: "Known adapters: \(SourceRegistry.adapters.map(\.id).joined(separator: ", ")).", status: 404)
    }
    if id.hasPrefix("cipher.") {
      guard PackLibrary.url(of: CipherPacks.meta, atlasPath: location.atlasPath) != nil else { throw PackLibrary.absent(CipherPacks.meta) }
      guard await BootstrapCipher.start(self) else { throw PackLibrary.absent(CipherPacks.meta) }
      // the supervisor queues the first phase that is not done; wait briefly for its job row
      for _ in 0..<50 {
        for phase in BootstrapCipher.Phase.allCases {
          if let job = try await BootstrapCipher.existingJob(self, phase) { return JobRefResponse(job: Int(job.rawValue)) }
        }
        let st = try await read { try BootstrapCipher.state($0) }
        if BootstrapCipher.isDone(.b, st) {
          throw ScrollsError(code: ErrorCode(rawValue: "E_ALREADY_LOADED"), message: "Cipher is already loaded on this phone.",
                             hint: "Its collections are ready in the corpora list.", status: 409)
        }
        try await Task.sleep(for: .milliseconds(100))
      }
      throw ScrollsError(code: ErrorCode(rawValue: "E_JOB_TYPE"), message: "The Cipher bootstrap did not start.",
                         hint: "This build does not run bootstrap-cipher jobs yet.", status: 503)
    }
    if id == DemoAdapter.adapterID {
      let job = try await jobQueue.enqueue(JobSpec(type: DemoLoadTask.type, params: ["force": .bool(false)], priority: 1))
      return JobRefResponse(job: Int(job.rawValue))
    }
    throw ScrollsError.notImplemented(area: "Loading \(id) on the phone (the STEMM pack and adapters): M2, package N2")
  }

  @concurrent
  public func enableAdapter(_ id: String, _ r: AdapterEnableRequest) async throws -> AdapterEnableResponse {
    throw ScrollsError.notImplemented(area: "Enabling and approving adapters (journaled): M2, package N2")
  }
}
