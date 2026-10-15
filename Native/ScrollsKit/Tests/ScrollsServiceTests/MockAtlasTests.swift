// OWNER: N0
// MockAtlas serves every fixture through AtlasService (IOS-SPEC §8.4.10): each of the 65 endpoints, every variant,
// gives exactly the fixture's body (or throws its error with the status), and variants are chosen as mock mode does.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsService
import ScrollsStore
import Testing

/// What one AtlasService call answered, as JSON where it is JSON.
enum Served: Equatable {
  case json(JSONValue)
  case text(String)
  case bytes(Data)
  case events([JSONValue])
  case empty
}

/// Calls the AtlasService method that serves `service` with placeholder arguments (the variant is forced by the
/// MockAtlas, so the arguments only need the right types).
func call(_ atlas: some AtlasService, _ service: String, events count: Int = 0) async throws -> Served {
  func j<T: Encodable>(_ v: T) throws -> Served { .json(try ScrollsJSON.value(v)) }
  let job = JobID(rawValue: 1)
  switch service {
  case "health": return try j(try await atlas.health())
  case "events":
    var out: [JSONValue] = []
    // the shared stream stays open (keep_open), so take the fixture's events
    for await e in atlas.events.prefix(count) { out.append(try eventJSON(e)) }
    return .events(out)
  case "jobs": return try j(try await atlas.jobs(JobsRequest()))
  case "job": return try j(try await atlas.job(job))
  case "jobEvents":
    var out: [JSONValue] = []
    for try await e in try await atlas.jobEvents(job).events { out.append(try eventJSON(.job(e))) }
    return .events(out)
  case "cancelJob": return try j(try await atlas.cancelJob(job))
  case "stageImport":
    return try j(try await atlas.stageImport(StageImportRequest(file: URL(fileURLWithPath: "/tmp/x.csv"), fileName: "x.csv")))
  case "setImportMapping": return try j(try await atlas.setImportMapping(1, ImportMappingRequest(mapping: [:])))
  case "importPreview": return try j(try await atlas.importPreview(1))
  case "importProblems": return .text(try await atlas.importProblems(1).csv)
  case "commitImport": return try j(try await atlas.commitImport(1, ImportMappingRequest(mapping: [:])))
  case "revertImport": return try j(try await atlas.revertImport(1))
  case "corpora": return try j(try await atlas.corpora())
  case "facets": return try j(try await atlas.facets(FacetsRequest()))
  case "adapters": return try j(try await atlas.adapters())
  case "adapterClaims": return try j(try await atlas.adapterClaims("stemm.wiktionary", AdapterClaimsRequest(word: "x")))
  case "loadAdapter": return try j(try await atlas.loadAdapter("stemm.openalex", AdapterLoadRequest()))
  case "enableAdapter": return try j(try await atlas.enableAdapter("stemm.openalex", AdapterEnableRequest(approve: true)))
  case "baseline": return try j(try await atlas.baseline(BaselineRequest(word: "x")))
  case "tour": return try j(try await atlas.tour())
  case "etymology": return try j(try await atlas.etymology(EtymologyRequest(expr: 1)))
  case "search": return try j(try await atlas.search(SearchRequest(q: "x")))
  case "trackExpression": return try j(try await atlas.trackExpression(TrackExpressionRequest(surface: "x")))
  case "expression": return try j(try await atlas.expression(1))
  case "setVariants": return try j(try await atlas.setVariants(1, VariantsPatchRequest(variants: [])))
  case "timelineQuery":
    return try j(try await atlas.timelineQuery(TimelineQueryRequest(strands: [StrandRequest(type: "expression", ref: .int(1))],
                                                                      corpus: "x", lanes: LanesRequest())))
  case "tiles": return try j(try await atlas.tiles(TilesRequest(q: "k", tier: "L2", tiles: "0")))
  case "marks": return try j(try await atlas.marks(MarksRequest(q: "k")))
  case "arcs": return try j(try await atlas.arcs(ArcsRequest(q: "k")))
  case "shelf": return try j(try await atlas.shelf(ShelfRequest(q: "k")))
  case "bin": return try j(try await atlas.bin(BinRequest(q: "k", lane: "l")))
  case "passage": return try j(try await atlas.passage(1, context: false))
  case "document": return try j(try await atlas.document(1))
  case "documentText": return try j(try await atlas.documentText(1))
  case "kwic": return try j(try await atlas.kwic(KwicRequest(expr: 1)))
  case "occurrence": return try j(try await atlas.occurrence(1))
  case "export":
    let e = try await atlas.export(ExportRequest(view: "v"))
    return e.contentType.hasPrefix("application/json") ? .json(try JSONValue.parse(e.data)) : .text(String(decoding: e.data, as: UTF8.self))
  case "createSnapshot": return try j(try await atlas.createSnapshot(SnapshotCreateRequest(view: "v")))
  case "snapshot": return .bytes(try await atlas.snapshot("x.png").data)
  case "compare":
    return try j(try await atlas.compare(CompareRequest(expr: [1], a: CompareSlice(years: [1, 2]), b: CompareSlice(years: [3, 4]))))
  case "collocations": return try j(try await atlas.collocations(CollocationsRequest(expr: 1)))
  case "clusters": return try j(try await atlas.clusters(ClustersRequest(expr: 1)))
  case "startRun": return try j(try await atlas.startRun(StartRunRequest(stage: "cluster")))
  case "runs": return try j(try await atlas.runs(RunsRequest()))
  case "constellation": return try j(try await atlas.constellation(ConstellationRequest(strands: "e1")))
  case "lineage": return try j(try await atlas.lineage(LineageRequest(root: "passage:1")))
  case "lineagePath": return try j(try await atlas.lineagePath(LineagePathRequest(from: "passage:1", to: "passage:2")))
  case "genealogy": return try j(try await atlas.genealogy(GenealogyRequest(work: "document:1")))
  case "relationship": return try j(try await atlas.relationship(1))
  case "proposeRelationship":
    return try j(try await atlas.proposeRelationship(ProposeRelationshipRequest(src: "passage:1", dst: "passage:2", relType: "proposed_allusion",
                                                                                 evidence: [], note: "a note of ten characters")))
  case "review": return try j(try await atlas.review(1, ReviewRequest(action: "confirm", note: "a note of ten characters")))
  case "addEvidence": return try j(try await atlas.addEvidence(1, EvidenceRequest(passage: 1, start: 0, end: 1)))
  case "hypothesisGroup": return try j(try await atlas.hypothesisGroup(1))
  case "createHypothesisGroup":
    return try j(try await atlas.createHypothesisGroup(HypothesisGroupCreateRequest(target: "passage:1", question: "q?")))
  case "trace": return try j(try await atlas.trace(TraceRequest(passage: 1, start: 0, end: 1)))
  case "annotations": return try j(try await atlas.annotations(AnnotationsRequest()))
  case "createAnnotation":
    return try j(try await atlas.createAnnotation(AnnotationCreateRequest(target: AnnotationTargetRef(type: "document", ref: "1"),
                                                                          kind: "interpretation", bodyMd: "b")))
  case "reviseAnnotation": return try j(try await atlas.reviseAnnotation(1, AnnotationPatchRequest(bodyMd: "b")))
  case "reinterpret":
    return try j(try await atlas.reinterpret(1, AnnotationCreateRequest(target: AnnotationTargetRef(type: "document", ref: "1"),
                                                                       kind: "interpretation", bodyMd: "b")))
  case "withdraw": return try j(try await atlas.withdraw(1, WithdrawRequest()))
  case "annotationRevisions": return try j(try await atlas.annotationRevisions(1))
  case "saveView": return try j(try await atlas.saveView(SaveViewRequest(name: "n", state: [:])))
  case "views": return try j(try await atlas.views())
  case "view": return try j(try await atlas.view("s", asSaved: false))
  case "deleteView":
    _ = try await atlas.deleteView("s")
    return .empty
  default:
    Issue.record("no call for \(service)")
    return .empty
  }
}

/// An AtlasEvent as the fixture's SSE `data` (to compare with the fixture).
func eventJSON(_ e: AtlasEvent) throws -> JSONValue {
  switch e {
  case .job(.progress(let p)): try ScrollsJSON.value(p)
  case .job(.done(let d)): try ScrollsJSON.value(d)
  case .dataChanged(let v): try ScrollsJSON.value(DataChangedPayload(dataVersion: v))
  case .adapter(let a): try ScrollsJSON.value(a)
  case .bootstrap(let b): try ScrollsJSON.value(b)
  case .generation, .journal, .thermal: .null
  }
}

private let bundled: [String: JSONValue] = {
  var out: [String: JSONValue] = [:]
  let dir = ServiceFixtures.bundledDir
  for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasSuffix(".json") {
    out[name] = try? JSONValue.parse(try Data(contentsOf: dir.appendingPathComponent(name)))
  }
  return out
}()

@Suite("MockAtlas")
struct MockAtlasTests {
  @Test("serves every variant of every fixture through AtlasService, exactly as the fixture holds it",
        arguments: ContractCatalog.endpoints.map(\.service))
  func servesEveryVariant(service: String) async throws {
    let endpoint = try #require(ContractCatalog.endpoint(service: service))
    let fixture = try #require(bundled[endpoint.fixtureFile], "\(endpoint.fixtureFile) is bundled")
    let variants = try #require(fixture["variants"]?.objectValue)
    for (name, v) in variants {
      let atlas = MockAtlas(variant: [service: name], eventDelayScale: 0)
      let status = v["status"]?.safeInteger ?? 200
      if status >= 400 {
        do {
          _ = try await call(atlas, service)
          // a failing SSE fixture ends the stream instead (no transport to carry the status)
          if service != "events" { Issue.record("\(service) [\(name)] should throw") }
        } catch let e as ScrollsError {
          #expect(e.status == status, "\(service) [\(name)] status")
          #expect(e.code.rawValue == v["body"]?["error"]?["code"]?.stringValue, "\(service) [\(name)] code")
          #expect(e.message == v["body"]?["error"]?["message"]?.stringValue, "\(service) [\(name)] message")
        }
        continue
      }
      let served = try await call(atlas, service, events: v["events"]?.arrayValue?.count ?? 0)
      switch served {
      case .json(let got):
        let want = try #require(v["body"], "\(service) [\(name)] has a body")
        #expect(CanonicalJSON.string(got) == CanonicalJSON.string(want), "\(service) [\(name)]")
      case .text(let got):
        #expect(got == v["text"]?.stringValue, "\(service) [\(name)] text")
      case .bytes(let got):
        #expect(got == Data(base64Encoded: v["base64"]?.stringValue ?? ""), "\(service) [\(name)] bytes")
      case .events(let got):
        let want = (v["events"]?.arrayValue ?? []).compactMap { $0["data"] }
        #expect(got.map(CanonicalJSON.string) == want.map(CanonicalJSON.string), "\(service) [\(name)] events")
      case .empty:
        #expect(status == 204, "\(service) [\(name)] is the 204 variant")
      }
    }
  }

  @Test("without a requested variant, the first variant whose `when` matches the request answers, else the default")
  func chooseByWhen() async throws {
    let atlas = MockAtlas(eventDelayScale: 0)
    #expect(try await atlas.passage(77, context: false).id == 77)
    #expect(try await atlas.passage(140, context: false).lang == "gu")
    #expect(try await atlas.passage(901, context: false).id == 901)
    #expect(try await atlas.job(JobID(rawValue: 288)).status == "succeeded")
    #expect(try await atlas.job(JobID(rawValue: 295)).status == "failed")
    #expect(try await atlas.shelf(ShelfRequest(q: "k", which: "scheduled")).which == "scheduled")
    #expect(try await atlas.marks(MarksRequest(q: "k", limit: 5)).truncated)
    #expect(try await atlas.search(SearchRequest(q: "hacker")).hits.passages == 0)
    let cipher = try await atlas.timelineQuery(TimelineQueryRequest(strands: [StrandRequest(type: "expression", ref: .int(1))],
                                                                    corpus: "cipher", lanes: LanesRequest()))
    #expect(!cipher.seams.isEmpty)
    let reviewed = try await atlas.review(1, ReviewRequest(action: "reject", note: "a note of ten characters"))
    #expect(reviewed.reviewStatus == "disputed")
  }

  @Test("'*' asks every endpoint for a variant of that name, falling back to its default")
  func wildcardVariant() async throws {
    let atlas = MockAtlas(variant: ["*": "empty"], eventDelayScale: 0)
    #expect(try await atlas.jobs(JobsRequest()).items.isEmpty)
    #expect(try await atlas.views().items.isEmpty)
    #expect(try await atlas.health().ok)
  }

  @Test("the events stream yields the fixture's job, data, bootstrap and adapter events in order")
  func eventsStream() async throws {
    var kinds: [String] = []
    for await e in MockAtlas(variant: ["events": "ok"], eventDelayScale: 0).events.prefix(5) {
      switch e {
      case .job(.progress): kinds.append("progress")
      case .job(.done): kinds.append("done")
      case .dataChanged: kinds.append("data")
      case .bootstrap: kinds.append("bootstrap")
      case .adapter: kinds.append("adapter")
      default: kinds.append("other")
      }
    }
    #expect(kinds == ["progress", "done", "data", "bootstrap", "adapter"])
  }
}
