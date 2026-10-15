// OWNER: N2
// LivePlatform's drop folders (IOS-SPEC §3.5, §3.9) on a temporary root: what waits is listed from Documents/Import
// (the app's own, always created) first, then the system's Documents/Inbox (AirDrop, "Open in"; iOS reserves it, so it
// may be missing); the same file in both (name and size) is listed once, from Import, two different files of one name
// are both listed, and every item says its folder; a pack installs from either folder, and an identical twin in the
// other folder goes with it while a different one stays; storage measures both folders; a pack opened in place is put
// in Import by `DropFolder.receive`.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsService
import ScrollsStore
import Testing

private func openTemporaryAtlas() async throws -> (LiveAtlas, AtlasLocation, URL) {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-liveplatform-\(UUID().uuidString)")
  let location = try AtlasLocation.at(root: root)
  let atlas = try await LiveAtlas.open(location, conditions: Unthrottled(), launch: .cli)
  return (atlas, location, root)
}

/// A small valid pack named `name` (one member whose bytes are `fill` repeated), written outside the drop folders.
private func makePack(_ name: String, fill: UInt8 = 0x61, scratch: URL) throws -> URL {
  let url = scratch.appendingPathComponent("\(name)-\(fill).\(PackFormat.fileExtension)")
  let manifest = PackManifest(packID: name, name: name, version: "1.0.0", slot: SourceSlot(rawValue: 7), adapterIDs: ["x.y"],
                              createdBy: "LivePlatformTests", referenceCommit: "0000000", licences: ["CC0"], attribution: ["test"],
                              caveats: [], members: [], counts: ["members": 1])
  var w = try PackWriter(url: url, manifest: manifest)
  try w.add(member: "FORMAT.md", data: Data(repeating: fill, count: 4096))
  _ = try w.finish()
  return url
}

private func put(_ file: URL, in dir: URL, as name: String) throws -> URL {
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let to = dir.appendingPathComponent(name)
  try FileManager.default.copyItem(at: file, to: to)
  return to
}

private func write(_ text: String, in dir: URL, as name: String) throws {
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  try Data(text.utf8).write(to: dir.appendingPathComponent(name))
}

@Suite("LivePlatform drop folders: Documents/Import and the system Inbox", .serialized)
struct LivePlatformTests {
  @Test("inbox lists Import first, then the system Inbox, each item with its folder; the same file in both is listed once, from Import")
  func bothFoldersListed() async throws {
    let (atlas, loc, root) = try await openTemporaryAtlas()
    defer { try? FileManager.default.removeItem(at: root) }
    #expect(loc.importDir.path.hasSuffix("/Documents/Import") && loc.inboxDir.path.hasSuffix("/Documents/Inbox"))
    #expect(DropFolder.allCases == [.import, .inbox])
    #expect(DropFolder.import.url(in: loc) == loc.importDir && DropFolder.inbox.url(in: loc) == loc.inboxDir)
    try write("a,b\n1,2\n", in: loc.importDir, as: "letters.csv")
    try write("same bytes\n", in: loc.importDir, as: "shared.txt")
    try write("hidden", in: loc.importDir, as: ".DS_Store")
    try write("a,b\n", in: loc.inboxDir, as: "airdropped.csv")
    try write("same bytes\n", in: loc.inboxDir, as: "shared.txt")
    try write("??", in: loc.inboxDir, as: "x.bin")
    let items = try await atlas.inbox()
    #expect(items.map(\.url.lastPathComponent) == ["letters.csv", "shared.txt", "airdropped.csv", "x.bin"])
    #expect(items.map(\.folder) == [.import, .import, .inbox, .inbox])
    #expect(items.map(\.kind) == [.importFile, .importFile, .importFile, .unknown])
    let shared = try #require(items.first { $0.url.lastPathComponent == "shared.txt" })
    #expect(shared.url.deletingLastPathComponent().lastPathComponent == "Import", "the Import copy wins the name")
    #expect(shared.bytes == Int64("same bytes\n".utf8.count))
    // the folder travels in the item's JSON
    let json = String(decoding: try JSONEncoder().encode(items[2]), as: UTF8.self)
    #expect(json.contains("\"folder\":\"inbox\""))
    #expect(try JSONDecoder().decode(InboxItem.self, from: Data(json.utf8)) == items[2])
    // the Inbox twin shows once the Import copy is gone
    try FileManager.default.removeItem(at: loc.importDir.appendingPathComponent("shared.txt"))
    let after = try await atlas.inbox()
    #expect(after.map(\.url.lastPathComponent) == ["letters.csv", "airdropped.csv", "shared.txt", "x.bin"])
    #expect(after.first { $0.url.lastPathComponent == "shared.txt" }?.folder == .inbox)
    await atlas.close()
  }

  @Test("a missing system Inbox is an empty one: Import still lists, packs and storage answer, nothing throws")
  func missingInbox() async throws {
    let (atlas, loc, root) = try await openTemporaryAtlas()
    defer { try? FileManager.default.removeItem(at: root) }
    let fm = FileManager.default
    try fm.removeItem(at: loc.inboxDir)
    #expect(try await atlas.inbox().isEmpty)
    try write("a,b\n", in: loc.importDir, as: "letters.csv")
    let items = try await atlas.inbox()
    #expect(items.map(\.url.lastPathComponent) == ["letters.csv"] && items.map(\.folder) == [.import])
    #expect(try await atlas.packs().filter { $0.location == .inbox }.isEmpty)
    let storage = try await atlas.storage()
    #expect(storage.areas["inbox"] == 0 && storage.areas["import"] == 4)
    // an Inbox that cannot be listed (here a file in its place) is empty too
    try Data("not a folder".utf8).write(to: loc.inboxDir)
    #expect(try await atlas.inbox().map(\.folder) == [.import])
    await atlas.close()
  }

  @Test("packs lists waiting packs from both folders, de-duplicated by name, Import first, each with its folder")
  func packsFromBothFolders() async throws {
    let (atlas, loc, root) = try await openTemporaryAtlas()
    defer { try? FileManager.default.removeItem(at: root) }
    let scratch = root.appendingPathComponent("scratch")
    let alpha = try makePack("alpha", scratch: scratch)
    let beta = try makePack("beta", scratch: scratch)
    _ = try put(alpha, in: loc.importDir, as: "alpha.scrollspack")
    _ = try put(alpha, in: loc.inboxDir, as: "alpha.scrollspack")
    _ = try put(beta, in: loc.inboxDir, as: "beta.scrollspack")
    try write("not a pack", in: loc.inboxDir, as: "broken.scrollspack")
    let waiting = try await atlas.packs().filter { $0.location == .inbox }
    #expect(waiting.map(\.name) == ["alpha", "beta", "broken"])
    #expect(waiting.map(\.folder) == [.import, .inbox, .inbox])
    #expect(waiting.map(\.verification) == [.unverified, .unverified, .failed])
    let items = try await atlas.inbox()
    #expect(items.map { "\($0.folder.rawValue)/\($0.url.lastPathComponent)" }
              == ["import/alpha.scrollspack", "inbox/beta.scrollspack", "inbox/broken.scrollspack"])
    #expect(items.map(\.compatible) == [true, true, false])
    #expect(items[0].note?.hasPrefix("alpha 1.0.0: 1 files") == true)
    await atlas.close()
  }

  @Test("a partial or damaged Import copy does not hide a good pack of the same name in the system Inbox: both are listed")
  func partialImportDoesNotHideInbox() async throws {
    let (atlas, loc, root) = try await openTemporaryAtlas()
    defer { try? FileManager.default.removeItem(at: root) }
    let fm = FileManager.default
    let scratch = root.appendingPathComponent("scratch")
    let stemm = try makePack("stemm", scratch: scratch)
    // an interrupted push left the first 100 bytes in Import; AirDrop then delivered the whole pack to the Inbox
    let whole = try Data(contentsOf: stemm)
    try fm.createDirectory(at: loc.importDir, withIntermediateDirectories: true)
    let partial = loc.importDir.appendingPathComponent("stemm.scrollspack")
    try whole.prefix(100).write(to: partial)
    let good = try put(stemm, in: loc.inboxDir, as: "stemm.scrollspack")
    let items = try await atlas.inbox()
    #expect(items.map { "\($0.folder.rawValue)/\($0.url.lastPathComponent)" } == ["import/stemm.scrollspack", "inbox/stemm.scrollspack"])
    #expect(items.map(\.compatible) == [false, true])
    let waiting = try await atlas.packs().filter { $0.location == .inbox }
    #expect(waiting.map(\.folder) == [.import, .inbox])
    #expect(waiting.map(\.verification) == [.failed, .unverified])
    // installing the good copy leaves the partial one (a different file) listed
    let s = try await atlas.installPack(good)
    #expect(s.name == "stemm" && s.verification == .verified)
    #expect(fm.fileExists(atPath: partial.path) && !fm.fileExists(atPath: good.path))
    #expect(try await atlas.inbox().map { "\($0.folder.rawValue)/\($0.url.lastPathComponent)" } == ["import/stemm.scrollspack"])
    await atlas.close()
  }

  @Test("DropFolder.receive: a file opened in place from outside is copied into Import (replacing a same-named one); drop-folder files stay; one at the Documents root moves in")
  func receiveIntoImport() async throws {
    let (atlas, loc, root) = try await openTemporaryAtlas()
    defer { try? FileManager.default.removeItem(at: root) }
    let fm = FileManager.default
    let documents = loc.importDir.deletingLastPathComponent()
    let outside = root.appendingPathComponent("iCloud Drive")
    let alpha = try put(try makePack("alpha", scratch: root.appendingPathComponent("scratch")), in: outside, as: "alpha.scrollspack")
    // a stale file of that name already waits in Import: the received one replaces it
    try write("stale", in: loc.importDir, as: "alpha.scrollspack")
    let received = try await DropFolder.receive(alpha, documents: documents)
    #expect(received.path == loc.importDir.appendingPathComponent("alpha.scrollspack").path)
    #expect(try Data(contentsOf: received) == Data(contentsOf: alpha), "copied whole, replacing the stale one")
    #expect(fm.fileExists(atPath: alpha.path), "the original stays where Files keeps it")
    #expect(try fm.contentsOfDirectory(atPath: loc.importDir.path).sorted() == ["alpha.scrollspack"], "no hidden partial left")
    #expect(try await atlas.inbox().map { "\($0.folder.rawValue)/\($0.url.lastPathComponent)" } == ["import/alpha.scrollspack"])
    // AirDrop's copy in the Inbox and a file already in Import stay where they are
    let beta = try put(try makePack("beta", scratch: outside), in: loc.inboxDir, as: "beta.scrollspack")
    #expect(try await DropFolder.receive(beta, documents: documents) == beta)
    #expect(try await DropFolder.receive(received, documents: documents) == received)
    #expect(!fm.fileExists(atPath: loc.importDir.appendingPathComponent("beta.scrollspack").path))
    // a Finder drag onto Scrolls lands at the Documents root: opened from there it moves into Import
    let loose = try put(try makePack("gamma", scratch: outside), in: documents, as: "gamma.scrollspack")
    let moved = try await DropFolder.receive(loose, documents: documents)
    #expect(moved.path == loc.importDir.appendingPathComponent("gamma.scrollspack").path)
    #expect(!fm.fileExists(atPath: loose.path) && fm.fileExists(atPath: moved.path))
    // a directory package (.scrollsatlas) is copied with its contents
    let package = outside.appendingPathComponent("gen.scrollsatlas")
    try write("{}", in: package, as: "ATLAS.json")
    let pkg = try await DropFolder.receive(package, documents: documents)
    #expect(fm.fileExists(atPath: pkg.appendingPathComponent("ATLAS.json").path))
    // a file that does not exist answers an error and leaves nothing behind
    await #expect(throws: (any Error).self) { _ = try await DropFolder.receive(outside.appendingPathComponent("gone.scrollspack"), documents: documents) }
    #expect(try fm.contentsOfDirectory(atPath: loc.importDir.path).sorted() == ["alpha.scrollspack", "gamma.scrollspack", "gen.scrollsatlas"])
    await atlas.close()
  }

  @Test("an Import that cannot be made (a file sits at that name) still opens the engine; the scan reads it as empty")
  func importBlockedByAFile() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-liveplatform-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    try write("not a folder", in: root.appendingPathComponent("Documents"), as: "Import")
    let loc = try AtlasLocation.at(root: root)
    let atlas = try await LiveAtlas.open(loc, conditions: Unthrottled(), launch: .cli)
    var isDir: ObjCBool = true
    #expect(FileManager.default.fileExists(atPath: loc.importDir.path, isDirectory: &isDir) && !isDir.boolValue)
    try write("a,b\n", in: loc.inboxDir, as: "airdropped.csv")
    #expect(try await atlas.inbox().map(\.folder) == [.inbox])
    _ = try await atlas.storage()
    await atlas.close()
  }

  @Test("install from either folder: the pack moves into Atlas/packs; an identical twin in the other folder goes too, a different one stays")
  func installFromEitherFolder() async throws {
    let (atlas, loc, root) = try await openTemporaryAtlas()
    defer { try? FileManager.default.removeItem(at: root) }
    let fm = FileManager.default
    let packsDir = loc.atlasDir.appendingPathComponent("packs")
    let scratch = root.appendingPathComponent("scratch")

    // from Import, with an identical twin in the Inbox
    let alpha = try makePack("alpha", scratch: scratch)
    let fromImport = try put(alpha, in: loc.importDir, as: "alpha.scrollspack")
    let twin = try put(alpha, in: loc.inboxDir, as: "alpha.scrollspack")
    let a = try await atlas.installPack(fromImport)
    #expect(a.name == "alpha" && a.location == .installed && a.verification == .verified && a.folder == nil)
    #expect(fm.fileExists(atPath: packsDir.appendingPathComponent("alpha.scrollspack").path))
    #expect(!fm.fileExists(atPath: fromImport.path) && !fm.fileExists(atPath: twin.path), "both drop folders are emptied of it")

    // from the system Inbox (sent by AirDrop), under another file name
    let beta = try makePack("beta", scratch: scratch)
    let fromInbox = try put(beta, in: loc.inboxDir, as: "beta-airdrop.scrollspack")
    let b = try await atlas.installPack(fromInbox)
    #expect(b.name == "beta" && b.location == .installed)
    #expect(fm.fileExists(atPath: packsDir.appendingPathComponent("beta.scrollspack").path))
    #expect(!fm.fileExists(atPath: fromInbox.path))

    // a different file of the same name in the other folder stays, and is listed next
    let gamma1 = try makePack("gamma", fill: 0x61, scratch: scratch)
    let gamma2 = try makePack("gamma", fill: 0x62, scratch: scratch)
    let g1 = try put(gamma1, in: loc.importDir, as: "gamma.scrollspack")
    let g2 = try put(gamma2, in: loc.inboxDir, as: "gamma.scrollspack")
    _ = try await atlas.installPack(g1)
    #expect(!fm.fileExists(atPath: g1.path) && fm.fileExists(atPath: g2.path))
    let left = try await atlas.inbox()
    #expect(left.map { "\($0.folder.rawValue)/\($0.url.lastPathComponent)" } == ["inbox/gamma.scrollspack"])

    let all = try await atlas.packs()
    #expect(all.filter { $0.location == .installed }.map(\.name) == ["alpha", "beta", "gamma"])
    #expect(all.filter { $0.location == .installed }.allSatisfy { $0.verification == .verified })
    #expect(all.filter { $0.location == .inbox }.map(\.folder) == [.inbox])
    await atlas.close()
  }

  @Test("storage measures Import and the system Inbox as their own areas")
  func storageAreas() async throws {
    let (atlas, loc, root) = try await openTemporaryAtlas()
    defer { try? FileManager.default.removeItem(at: root) }
    try write(String(repeating: "i", count: 300), in: loc.importDir, as: "a.txt")
    try write(String(repeating: "x", count: 70), in: loc.inboxDir, as: "b.txt")
    let s = try await atlas.storage()
    #expect(s.areas["import"] == 300)
    #expect(s.areas["inbox"] == 70)
    await atlas.close()
  }
}
