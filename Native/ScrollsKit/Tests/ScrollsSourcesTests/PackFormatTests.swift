// OWNER: N2
// The source-pack format SPK1 (IOS-SPEC §3.5; Native/Docs/PACK-FORMAT.md): members round-trip byte for byte, a range
// read decodes only its frames and equals the slice of the original across frame boundaries, incompressible frames are
// stored raw, the whole file's sha256 equals what the writer returned, a member's sha256 is checked on its first full
// read, the manifest is canonical JSON, and damaged or foreign files are refused with E_PACK_* and words.

import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsSources
import ScrollsStore
import Testing

@Suite("Source packs (SPK1)")
struct PackFormatTests {
  static func tmp(_ name: String) -> URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("n2-pack-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d.appendingPathComponent(name)
  }

  static func manifest(_ name: String = "test") -> PackManifest {
    PackManifest(packID: name, name: name, version: "1.0.0", slot: SourceSlot(rawValue: 7), adapterIDs: ["x.y"],
                 createdBy: "scrolls-cli test", referenceCommit: "839c3f1", licences: ["CC0"], attribution: ["test"],
                 caveats: ["a caveat"], members: [], counts: ["members": 4, "files:texts": 2])
  }

  static func hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

  /// Deterministic bytes: compressible text, or noise.
  static func bytes(_ n: Int, noise: Bool, seed: UInt64) -> Data {
    var x = seed &* 6364136223846793005 &+ 1442695040888963407
    var out = Data(capacity: n)
    let words = Array("the zero holds the place where nothing is, so that something can be counted. ".utf8)
    for i in 0..<n {
      if noise {
        x = x &* 6364136223846793005 &+ 1442695040888963407
        out.append(UInt8(truncatingIfNeeded: x >> 33))
      } else {
        out.append(words[(i + Int(seed)) % words.count])
      }
    }
    return out
  }

  /// A pack with an empty member, a small one, a 2.5 MiB compressible one and a 1.3 MiB incompressible one.
  static func sample() throws -> (url: URL, sha: String, members: [String: Data]) {
    let url = tmp("t.scrollspack")
    let members: [(String, Data)] = [
      ("FORMAT.md", Data("# test\n".utf8)), ("empty.txt", Data()),
      ("texts/a.txt", bytes(5 * (1 << 19), noise: false, seed: 3)), ("texts/noise.bin", bytes(1_300_000, noise: true, seed: 9)),
    ]
    var w = try PackWriter(url: url, manifest: manifest())
    for (p, d) in members { try w.add(member: p, data: d) }
    let sha = try w.finish()
    return (url, sha, Dictionary(uniqueKeysWithValues: members))
  }

  @Test("members round-trip byte for byte; the manifest lists them with their sha256 in order")
  func roundTrip() async throws {
    let (url, sha, members) = try Self.sample()
    let r = try PackReader(url: url)
    #expect(r.memberPaths == ["FORMAT.md", "empty.txt", "texts/a.txt", "texts/noise.bin"])
    #expect(r.manifest.name == "test" && r.manifest.slot.rawValue == 7 && r.manifest.adapterIDs == ["x.y"])
    for (p, d) in members {
      #expect(try r.data(member: p) == d, "member \(p)")
      #expect(r.info(p)?.sha256 == Self.hex(d))
      #expect(r.info(p)?.size == Int64(d.count))
      #expect(try await r.verify(member: p))
    }
    #expect(try await r.fileSHA256() == sha)
    #expect(Self.hex(try Data(contentsOf: url)) == sha)
    // no side files are left behind
    let dir = try FileManager.default.contentsOfDirectory(atPath: url.deletingLastPathComponent().path)
    #expect(dir == ["t.scrollspack"])
  }

  @Test("range reads decode only the covering frames and equal the original slice, across frame boundaries")
  func ranges() throws {
    let (url, _, members) = try Self.sample()
    let r = try PackReader(url: url)
    let a = members["texts/a.txt"]!, n = members["texts/noise.bin"]!
    let f = Int64(PackFormat.frameSize)
    for (lo, hi) in [(0, 10), (f - 5, f + 5), (f - 1, 2 * f + 1), (2 * f, Int64(a.count)), (Int64(a.count) - 1, Int64(a.count) + 99)] {
      let want = a.subdata(in: Int(lo)..<min(a.count, Int(hi)))
      #expect(try r.bytes(member: "texts/a.txt", range: lo..<hi) == want, "\(lo)..<\(hi)")
    }
    #expect(try r.bytes(member: "texts/noise.bin", range: (f - 3)..<(f + 3)) == n.subdata(in: Int(f - 3)..<Int(f + 3)))
    #expect(try r.bytes(member: "empty.txt", range: 0..<10).isEmpty)
  }

  @Test("an incompressible frame is stored raw; a compressible one shrinks; the file is smaller than its members")
  func storage() throws {
    let (url, _, members) = try Self.sample()
    let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as! NSNumber
    let raw = members.values.reduce(0) { $0 + $1.count }
    #expect(size.intValue < raw)
    #expect(size.intValue > members["texts/noise.bin"]!.count, "noise cannot be compressed")
  }

  @Test("the stream yields the member frame by frame")
  func stream() async throws {
    let (url, _, members) = try Self.sample()
    let r = try PackReader(url: url)
    var got = Data(), frames = 0
    for try await chunk in r.stream(member: "texts/a.txt") {
      got.append(chunk)
      frames += 1
    }
    #expect(got == members["texts/a.txt"]!)
    #expect(frames == 3)
  }

  @Test("the manifest is canonical JSON and reads back equal")
  func manifestJSON() throws {
    let m = Self.manifest().with(members: [PackMemberInfo(path: "a", size: 3, sha256: "00")])
    let text = m.canonicalJSON
    #expect(try PackManifest(json: try JSONValue.parse(Data(text.utf8))) == m)
    #expect(text.hasPrefix("{\"adapter_ids\":[\"x.y\"],\"attribution\":[\"test\"]"))
    #expect(CanonicalJSON.string(try JSONValue.parse(Data(text.utf8))) == text)
  }

  @Test("a damaged member fails its sha256 on the first full read, with words; the rest still reads")
  func damagedMember() throws {
    let (url, _, members) = try Self.sample()
    // flip one byte inside the last member's stored bytes (noise is stored raw, so the frame still decodes)
    var bytes = try Data(contentsOf: url)
    bytes[bytes.count - 10] ^= 0xFF
    try bytes.write(to: url)
    let r = try PackReader(url: url)
    #expect(try r.data(member: "texts/a.txt") == members["texts/a.txt"]!)
    do {
      _ = try r.data(member: "texts/noise.bin")
      Issue.record("a damaged member was read without complaint")
    } catch let e as ScrollsError {
      #expect(e.code == PackError.checksumCode)
      #expect(e.message.contains("does not match its sha256"))
    }
  }

  @Test("foreign files, other versions, truncation and unknown members are refused with E_PACK_*")
  func refusals() throws {
    let (url, _, _) = try Self.sample()
    let bad = Self.tmp("bad.scrollspack")
    try Data("not a pack at all, just some text that is long enough".utf8).write(to: bad)
    #expect(throws: ScrollsError.self) { try PackReader(url: bad) }
    var v2 = try Data(contentsOf: url)
    v2[11] = 2
    try v2.write(to: bad)
    do {
      _ = try PackReader(url: bad)
      Issue.record("version 2 was accepted")
    } catch let e as ScrollsError {
      #expect(e.code == PackError.invalidCode && e.message.contains("format version 2"))
    }
    let whole = try Data(contentsOf: url)
    try whole.prefix(whole.count - 100_000).write(to: bad)
    #expect(throws: ScrollsError.self) { try PackReader(url: bad) }
    let r = try PackReader(url: url)
    do {
      _ = try r.bytes(member: "nope", range: 0..<1)
      Issue.record("an unknown member was read")
    } catch let e as ScrollsError {
      #expect(e.code == PackError.memberCode)
    }
  }

  @Test("a member path must be relative and inside the pack, and unique")
  func memberPaths() throws {
    var w = try PackWriter(url: Self.tmp("p.scrollspack"), manifest: Self.manifest())
    #expect(throws: ScrollsError.self) { try w.add(member: "/abs", data: Data()) }
    #expect(throws: ScrollsError.self) { try w.add(member: "a/../b", data: Data()) }
    try w.add(member: "a", data: Data("x".utf8))
    #expect(throws: ScrollsError.self) { try w.add(member: "a", data: Data("y".utf8)) }
    _ = try w.finish()
  }

  @Test("the same members give the same bytes (packs are deterministic)")
  func deterministic() throws {
    let a = try Self.sample(), b = try Self.sample()
    #expect(a.sha == b.sha)
  }

  @Test("SourceFiles resolves members across packs in order and records originals as pack:<name>@<sha8>/<member>")
  func sourceFiles() async throws {
    let (url, sha, _) = try Self.sample()
    let other = Self.tmp("o.scrollspack")
    var w = try PackWriter(url: other, manifest: Self.manifest("other"))
    try w.add(member: "texts/a.txt", data: Data("shadowed".utf8))
    try w.add(member: "only-here.txt", data: Data("\u{FEFF}bom".utf8))
    let sha2 = try w.finish()
    let files = SourceFiles([SourceFiles.Pack(reader: try PackReader(url: url), sha256: sha),
                             SourceFiles.Pack(reader: try PackReader(url: other), sha256: sha2)])
    #expect(files.pack(holding: "texts/a.txt")?.name == "test")
    #expect(files.pack(holding: "only-here.txt")?.name == "other")
    #expect(files.members(prefix: "texts/") == ["texts/a.txt", "texts/noise.bin"])
    try files.keep("only-here.txt")
    try files.keep("only-here.txt")
    let kept = files.drainKept()
    #expect(kept.count == 1)
    #expect(kept[0].relPath == "pack:other@\(sha2.prefix(8))/only-here.txt")
    #expect(kept[0].hadBOM)
    #expect(files.drainKept().isEmpty)
    #expect(throws: ScrollsError.self) { try files.data("missing.txt") }
  }

  @Test("the demo pack carries data/demo byte for byte and is deterministic")
  func demoPack() throws {
    let a = try DemoPack.write(to: Self.tmp("demo.scrollspack"))
    let b = try DemoPack.write(to: Self.tmp("demo.scrollspack"))
    #expect(a.sha256 == b.sha256)
    #expect(a.reader.memberPaths == DemoPack.members)
    for m in DemoPack.members { #expect(try a.reader.data(member: m) == DemoPack.resource(m)) }
    #expect(a.reader.manifest.slot == .base)
  }
}
