// OWNER: N0
// IOS-SPEC §6.2, §8.4.10 item 2: the journal's append (canonical JSON line, CRC-32 over {seq, at, actor, op}, made
// durable before it returns), the torn last line (unterminated, or failing its CRC) truncated at open, damage in the
// middle reported rather than skipped, rotation, ordered replay across files, and every JournalOp — with the contract
// request bodies of tests/contract — surviving a line round trip.

import Foundation
import ScrollsContracts
import ScrollsCore
@testable import ScrollsStore
import Testing

@Suite("Journal")
struct JournalTests {
  static func request<T: Decodable>(_ type: T.Type, _ fixture: String) throws -> T {
    let url = Fixtures.scrollsRoot.appendingPathComponent("tests/contract/\(fixture).json")
    let body = try #require(try JSONValue.parse(Data(contentsOf: url))["example_request"], "\(fixture) has no example_request")
    return try ScrollsJSON.decode(type, from: body)
  }

  static let doc = DocKey(collection: "cipher-gutenberg", extId: "pg:1342")
  static let anchor = PassageAnchor(doc: doc, originalSha256: String(repeating: "a", count: 64), field: "body", start: 120,
                                    end: 131, quote: "carry the zero", prefix: "and then ", suffix: ", she said")
  static let run = RunKey(stage: Stage(rawValue: "cluster"), paramsHash: "p", inputFingerprint: "f", codeHash: "c")
  static let expr = ExprKey(kind: "phrase", lang: "en", norm: "carry the zero", corpus: "demo")

  /// One op of every case.
  static func everyOp() throws -> [JournalOp] {
    [
      .sourceLoad(SourceLoadOp(pack: "cipher-meta", packSha256: "abc", adapterId: "cipher.works", adapterVersion: "1.0.0",
                               phase: "A", params: ["timeBasis": "publication", "limit": 5], slot: .cipherMeta)),
      .adapterEnable(adapter: "stemm.openalex", enabled: false),
      .importCommit(ImportCommitOp(originalSha256: "def", originalPath: "originals/de/def", fileName: "letters.csv", format: "csv",
                                   mapping: ["text": "body"], options: [:], collection: ["slug": "letters", "name": "Letters"])),
      .importRevert(BatchKey(collection: "letters", fileSha256: "def", adapterId: "file.csv", ordinal: 0)),
      .trackExpression(expr, try request(TrackExpressionRequest.self, "POST__api_expressions")),
      .setVariants(expr, try request(VariantsPatchRequest.self, "PATCH__api_expressions_{id}_variants")),
      .annotationCreate(AnnotationCreateOp(target: .endpoint(key: .passage(anchor: anchor)), request: ["kind": "interpretation", "body_md": "x"])),
      .annotationRevise(AnnotationKey(seq: 7), try request(AnnotationPatchRequest.self, "PATCH__api_annotations_{id}")),
      .annotationReinterpret(AnnotationKey(seq: 7), AnnotationCreateOp(target: .annotation(key: AnnotationKey(seq: 7)), request: [:])),
      .annotationWithdraw(AnnotationKey(seq: 7), reason: "superseded by a better reading"),
      .relationshipPropose(RelationshipProposeOp(src: .document(key: doc), dst: .occurrence(expr: expr, anchor: anchor),
                                                 group: HypothesisGroupKey(seq: 3), evidence: [anchor], request: ["rel_type": "inspired_by"])),
      .relationshipReview(.human(seq: 9), try request(ReviewRequest.self, "POST__api_relationships_{id}_review")),
      .relationshipEvidence(.computed(run: run, src: .etymon(key: "sa:शून्य"), dst: .cluster(key: ClusterKey(run: run, ordinal: 2))),
                            try request(EvidenceRequest.self, "POST__api_relationships_{id}_evidence")),
      .hypothesisGroupCreate(HypothesisGroupCreateOp(target: .expression(key: expr), request: ["question": "where from?"])),
      .dimensionDefine(DimensionDefOp(key: "register", label: "Register", type: "enum", options: ["formal", "casual"])),
      .clusterLabel(ClusterKey(run: run, ordinal: 1), label: "money · account"),
      .runCommit(run, stage: Stage(rawValue: "reuse-index"), params: ["k": 5]),
      .viewSave(try request(SaveViewRequest.self, "POST__api_views"),
                portable: PortableCutoffs(generation: "g-1", journalSeq: 12, runKeys: ["14": run], strands: ["e12": expr],
                                          selection: .relationship(key: .documented(hash: "h")), packs: ["abc"])),
      .viewDelete(slug: "carry-the-zero-3f9a"),
    ]
  }

  @Test("CRC-32 is zlib's (check value of \"123456789\")")
  func crc() {
    #expect(CRC32.checksum(Array("123456789".utf8)) == 0xCBF4_3926)
    #expect(CRC32.checksum([]) == 0)
  }

  @Test("every JournalOp case survives a journal line round trip (contract requests from tests/contract)")
  func everyOpRoundTrips() throws {
    let ops = try Self.everyOp()
    #expect(Set(ops.map(\.name)).count == 19)
    for (k, op) in ops.enumerated() {
      let entry = try JournalEntry(seq: UInt64(k + 1), at: "2026-10-10T00:00:00.000Z", actor: "human:utkarsh", op: op)
      let line = try entry.line()
      #expect(line.hasSuffix("\n") && !line.dropLast().contains("\n"))
      let back = try JournalEntry.parse(line: String(line.dropLast()))
      #expect(back == entry, "\(op.name) did not survive")
      // the line is canonical JSON, and its CRC covers {seq, at, actor, op}
      let v = try JSONValue.parse(String(line.dropLast()))
      #expect(CanonicalJSON.string(v) + "\n" == line)
      guard case .object(var o) = v else { continue }
      o["crc32"] = nil
      #expect(CRC32.checksum(Array(CanonicalJSON.string(.object(o)).utf8)) == entry.crc32)
    }
    let sample = try JournalEntry(seq: 1, at: "t", actor: "scrolls", op: .viewDelete(slug: "v")).line()
    #expect(sample == #"{"actor":"scrolls","at":"t","crc32":"# + String(try JournalEntry(seq: 1, at: "t", actor: "scrolls", op: .viewDelete(slug: "v")).crc32) + #","op":{"view_delete":{"slug":"v"}},"seq":1}"# + "\n")
  }

  @Test("append: sequence numbers, the line on disk when append returns, reopen continues")
  func appendAndReopen() async throws {
    let dir = try Fixtures.tempDir("journal")
    let j = try JournalFile(directory: dir)
    #expect(await j.head == 0)
    var entries: [JournalEntry] = []
    for op in try Self.everyOp().prefix(5) {
      let e = try await j.append(op, actor: "human:utkarsh")
      entries.append(e)
      // durable before append returns: an independent read sees the whole line
      let onDisk = try String(contentsOf: dir.appendingPathComponent("journal-000001.jsonl"), encoding: .utf8)
      #expect(onDisk.hasSuffix(try e.line()))
    }
    #expect(entries.map(\.seq) == [1, 2, 3, 4, 5])
    let reopened = try JournalFile(directory: dir)
    #expect(await reopened.head == 5)
    #expect(reopened.truncatedBytes == 0)
    #expect(try await reopened.append(.viewDelete(slug: "x"), actor: "human:utkarsh").seq == 6)
    var replay: [JournalEntry] = []
    for try await e in reopened.entries(after: 2) { replay.append(e) }
    #expect(replay.map(\.seq) == [3, 4, 5, 6])
    #expect(Array(replay.prefix(3)) == Array(entries[2...]))
  }

  @Test("a torn last line (no newline) is truncated at open; the next append continues the sequence")
  func tornUnterminated() async throws {
    let dir = try Fixtures.tempDir("journal")
    let j = try JournalFile(directory: dir)
    for k in 0..<3 { _ = try await j.append(.viewDelete(slug: "v\(k)"), actor: "scrolls") }
    let file = dir.appendingPathComponent("journal-000001.jsonl")
    let before = try Data(contentsOf: file)
    let h = try FileHandle(forWritingTo: file)
    try h.seekToEnd()
    try h.write(contentsOf: Data(#"{"actor":"scrolls","at":"2026-10-10T00:0"#.utf8))
    try h.close()
    let reopened = try JournalFile(directory: dir)
    #expect(reopened.truncatedBytes == 40)
    #expect(await reopened.head == 3)
    #expect(try Data(contentsOf: file) == before)
    #expect(try await reopened.append(.viewDelete(slug: "v3"), actor: "scrolls").seq == 4)
  }

  @Test("a last line that fails its CRC is torn too and is truncated")
  func tornChecksum() async throws {
    let dir = try Fixtures.tempDir("journal")
    let j = try JournalFile(directory: dir)
    _ = try await j.append(.viewDelete(slug: "a"), actor: "scrolls")
    let file = dir.appendingPathComponent("journal-000001.jsonl")
    let good = try Data(contentsOf: file)
    let bad = try JournalEntry(seq: 2, at: "t", actor: "scrolls", op: .viewDelete(slug: "b")).line()
      .replacingOccurrences(of: #""slug":"b""#, with: #""slug":"c""#)
    let h = try FileHandle(forWritingTo: file)
    try h.seekToEnd()
    try h.write(contentsOf: Data(bad.utf8))
    try h.close()
    let reopened = try JournalFile(directory: dir)
    #expect(await reopened.head == 1)
    #expect(try Data(contentsOf: file) == good)
  }

  @Test("a damaged line followed by more lines is corruption: open fails and names the line")
  func corruptMiddle() async throws {
    let dir = try Fixtures.tempDir("journal")
    let j = try JournalFile(directory: dir)
    for k in 0..<3 { _ = try await j.append(.viewDelete(slug: "v\(k)"), actor: "scrolls") }
    let file = dir.appendingPathComponent("journal-000001.jsonl")
    let text = try String(contentsOf: file, encoding: .utf8).replacingOccurrences(of: #""slug":"v1""#, with: #""slug":"vX""#)
    try Data(text.utf8).write(to: file)
    let e = #expect(throws: JournalError.self) { try JournalFile(directory: dir) }
    #expect(e == .corrupt(file: "journal-000001.jsonl", line: 2, reason: String(describing: JournalError.checksum(seq: 2))))
    var seen: [UInt64] = []
    await #expect(throws: JournalError.self) { for try await x in j.entries(after: 0) { seen.append(x.seq) } }
    #expect(seen == [1])
  }

  @Test("rotation: files roll over at the size limit; replay crosses files in order; reopen appends to the newest")
  func rotation() async throws {
    let dir = try Fixtures.tempDir("journal")
    let j = try JournalFile(directory: dir, rotateBytes: 1024)
    for k in 0..<30 { _ = try await j.append(.annotationWithdraw(AnnotationKey(seq: UInt64(k)), reason: String(repeating: "r", count: 100)), actor: "human:utkarsh") }
    let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix("journal-") }.sorted()
    #expect(files.count >= 5, "\(files)")
    #expect(files.first == "journal-000001.jsonl")
    for f in files.dropLast() {
      let size = try FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(f).path)[.size] as? Int ?? 0
      #expect(size <= 1024)
    }
    var all: [UInt64] = []
    for try await e in j.entries(after: 0) { all.append(e.seq) }
    #expect(all == Array(1...30))
    let reopened = try JournalFile(directory: dir, rotateBytes: 1024)
    #expect(await reopened.head == 30)
    #expect(try await reopened.append(.viewDelete(slug: "z"), actor: "scrolls").seq == 31)
  }

  @Test("concurrent appends are serialised: unique, gapless sequence numbers in file order")
  func concurrentAppends() async throws {
    let dir = try Fixtures.tempDir("journal")
    let j = try JournalFile(directory: dir)
    try await withThrowingTaskGroup(of: UInt64.self) { g in
      for k in 0..<40 { g.addTask { try await j.append(.viewDelete(slug: "s\(k)"), actor: "scrolls").seq } }
      var seqs: [UInt64] = []
      for try await s in g { seqs.append(s) }
      #expect(seqs.sorted() == Array(1...40))
    }
    var order: [UInt64] = []
    for try await e in j.entries(after: 0) { order.append(e.seq) }
    #expect(order == Array(1...40))
  }
}
