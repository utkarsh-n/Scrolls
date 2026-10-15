// OWNER: N2
// Port of `server/adapters/demo/demo.mjs`: source adapter 'demo': the SYNTHETIC demonstration corpus "carry the zero"
// (SPEC §9) → corpus demo, collection demo-world. Every row it leads to is is_synthetic=1 (the writer copies it from
// the synthetic corpus). The files are the reference's data/demo/*.jsonl and tour.json, byte for byte, shipped as
// engine resources (`Resources/demo/`); like every source they are read as members of a pack — the `demo` pack, which
// `DemoPack` writes from the resources (IOS-SPEC §3.5: "demo · engine resource") — so the originals of demo documents
// are `pack:demo@<sha8>/documents.jsonl` as every other source's are.

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// The demo pack, built from the engine's resources.
public enum DemoPack {
  public static let name = "demo"
  public static let members = ["documents.jsonl", "relationships.jsonl", "annotations.jsonl", "tour.json"]

  /// The engine resource folder holding the demo files.
  public static var resources: URL? { Bundle.module.url(forResource: "demo", withExtension: nil) }

  /// The bytes of one demo resource.
  public static func resource(_ member: String) throws -> Data {
    guard let dir = resources else {
      throw ScrollsError(code: ErrorCode(rawValue: "E_ADAPTER_UNAVAILABLE"), message: "The demo resources are not in this build.",
                         hint: "Build the engine with ScrollsSources' Resources/demo.", status: 500)
    }
    return try Data(contentsOf: dir.appendingPathComponent(member))
  }

  /// The sha256 of the demo resources (in member order) and the engine version: what the demo pack's bytes depend on.
  public static func resourcesDigest() throws -> String {
    var h = SHA256()
    h.update(data: Data("\(BuildInfo.engineVersion)\n".utf8))
    for m in members { h.update(data: try resource(m)) }
    return h.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /// Writes the demo pack to `url` (deterministic: the same resources and engine version give the same bytes) and
  /// returns it opened, with its sha256.
  public static func write(to url: URL) throws -> SourceFiles.Pack {
    let manifest = PackManifest(
      packID: "demo", name: name, version: "1.0.0", slot: .base, adapterIDs: ["demo"],
      createdBy: "scrolls-engine \(BuildInfo.engineVersion)", referenceCommit: "data/demo (ref-freeze-1)",
      licences: ["CC0 (synthetic)"], attribution: ["Scrolls demo (synthetic)"],
      caveats: ["Everything here is invented: people, texts, dates and links."], members: [], counts: [:])
    var writer = try PackWriter(url: url, manifest: manifest)
    for m in members { try writer.add(member: m, data: try resource(m)) }
    let sha = try writer.finish()
    return SourceFiles.Pack(reader: try PackReader(url: url), sha256: sha)
  }
}

/// Source adapter 'demo'.
public struct DemoAdapter: PackBoundAdapter, CollectionCaveats {
  public static let adapterID = "demo"
  public static let collection = "demo-world"
  public static let packNames = [DemoPack.name]

  public let id = DemoAdapter.adapterID
  public let version = "1.0.0"
  public let label = "Synthetic demonstration — carry the zero"
  public let access = AdapterAccess.localFile
  public let license = "CC0 (synthetic)"
  public let attribution = "Scrolls demo (synthetic)"
  public let collections = [
    CollectionSpec(slug: DemoAdapter.collection, name: "Quellhaven (synthetic)", domain: "demo", modality: "text",
                   unit: "tokens", sampling: "curated", rateEligible: true, exportTextAllowed: true, coverageGate: 2000,
                   selectionNote: "invented corpus; coverage gate 2,000 tokens (demo setting; real collections use 50,000)"),
  ]
  public let collectionCaveats = [
    DemoAdapter.collection: [
      "Everything here is invented: people, texts, dates and links.",
      "No sources 1940–1949: the Quellhaven Board of Schools archive was 'lost in the 1951 flood' (synthetic).",
    ],
  ]
  public let files: SourceFiles

  public init(files: SourceFiles = .none) { self.files = files }
  public func bound(to files: SourceFiles) -> DemoAdapter { DemoAdapter(files: files) }

  /// The lines of a demo JSONL member as JSON values, with their byte ranges.
  func records(_ member: String) throws -> [(value: JSONValue, byteStart: Int, byteEnd: Int)] {
    let data = try files.data(member)
    return try CipherFormat.lines(data).compactMap { l in
      let text = CipherFormat.text(data, l.byteStart, l.byteEnd)
      guard !JSString.trim(text).isEmpty else { return nil }
      return (try CipherJSON.parse(Data(text.utf8), what: member), l.byteStart, l.byteEnd)
    }
  }

  func decode<T: Decodable>(_ type: T.Type, _ v: JSONValue) throws -> T {
    try ScrollsJSON.decoder.decode(T.self, from: Data(CanonicalJSON.string(v).utf8))
  }

  public func probe(_ context: AdapterContext) async throws -> AdapterProbeResult {
    guard !files.packs.isEmpty else { return .packMissing(Self.packNames) }
    let missing = DemoPack.members.filter { !files.contains($0) }
    if !missing.isEmpty {
      return AdapterProbeResult(available: false, reason: "missing \(missing.joined(separator: ", ")) (run npm run build:demo)",
                                manifestOK: false, formatOK: false)
    }
    return AdapterProbeResult(available: true, manifestOK: true, formatOK: true,
                              counts: ["documents": try records("documents.jsonl").count,
                                       "relationships": try records("relationships.jsonl").count,
                                       "annotations": try records("annotations.jsonl").filter { $0.value["deferred"] == nil }.count])
  }

  public func plan(_ params: JSONValue, _ context: AdapterContext) async throws -> Int { try records("documents.jsonl").count }

  /// The CanonicalDocument records (already canonical: built by scripts/build-demo.mjs), each pointing at its line in
  /// documents.jsonl (source_file, the D18 provenance chain).
  public func documents(_ params: JSONValue, _ context: AdapterContext,
                        into channel: BoundedChannel<[CanonicalDocument]>) async throws {
    let sha = try files.keep("documents.jsonl")
    var out = BatchSender(channel)
    for r in try records("documents.jsonl") {
      try Task.checkCancellation()
      var doc = try decode(CanonicalDocument.self, r.value)
      doc.sourceFile = SourceFileSpan(sha256: sha, byteStart: r.byteStart, byteEnd: r.byteEnd)
      try await out.append(doc)
    }
    try await out.flush()
  }

  /// Authored relationships of the synthetic world (their reviews are applied after loading).
  public func relationships(_ params: JSONValue, _ context: AdapterContext,
                            into channel: BoundedChannel<[CanonicalRelationship]>) async throws {
    try files.keep("relationships.jsonl")
    var out = BatchSender(channel)
    for r in try records("relationships.jsonl") {
      var o = r.value.objectValue ?? [:]
      o["key"] = nil
      o["review"] = nil
      try await out.append(try decode(CanonicalRelationship.self, .object(o)))
    }
    try await out.flush()
  }

  /// Authored annotations (revisions and deferred items are applied after loading).
  public func annotations(_ params: JSONValue, _ context: AdapterContext,
                          into channel: BoundedChannel<[CanonicalAnnotation]>) async throws {
    try files.keep("annotations.jsonl")
    var out = BatchSender(channel)
    for r in try records("annotations.jsonl") where r.value["deferred"] == nil {
      var o = r.value.objectValue ?? [:]
      o["revisions"] = nil
      try await out.append(try decode(CanonicalAnnotation.self, .object(o)))
    }
    try await out.flush()
  }

  /// The demo's authored reviews (relationships.jsonl `review`) and revisions (annotations.jsonl `revisions`), and the
  /// deferred items, for the human layer the provenance package applies.
  public func humanLayer() throws -> (reviews: [JSONValue], revisions: [JSONValue], deferred: [JSONValue]) {
    let rels = try records("relationships.jsonl").map(\.value).filter { $0["review"] != nil }
    let anns = try records("annotations.jsonl").map(\.value)
    return (rels, anns.filter { $0["revisions"] != nil && $0["deferred"] == nil }, anns.filter { $0["deferred"] != nil })
  }

  /// The guided tour as stored (ids are resolved by the tour route).
  public func tour() throws -> JSONValue { try CipherJSON.parse(try files.data("tour.json"), what: "tour.json") }
}
