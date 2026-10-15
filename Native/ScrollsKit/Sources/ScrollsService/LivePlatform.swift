// OWNER: N2
// The pack, inbox, generation and storage half of AtlasPlatform (IOS-SPEC §1.6, §3.5, §3.9, §4.16, §8.4.6), on LiveAtlas.
// The probe, trim, replay status, self-test steps, diagnostics and job suspension are LiveAtlas's own (LiveAtlas.swift).
// - packs: the bundled packs (the app bundle's Bundled/), the installed ones (Atlas/packs/) and the ones waiting in a
//   drop folder, each with its manifest facts, its verification state and whether its sources are loaded here;
// - installPack: the whole file's sha256 streamed (CryptoKit), the manifest read, then a rename into Atlas/packs
//   (same volume: no copy), and an identical twin of the same name in the other drop folder removed; loading it is
//   AtlasService.loadAdapter;
// - inbox: what waits in the drop folders, each with its folder and its compatibility in words (§3.5 step 1);
// - generations: the current generation's facts (meta), and Atlas.next / Atlas.prev when they exist (ATLAS.json);
// - storage: the measured bytes by area and the free space; purgeCaches empties Library/Caches/Scrolls.
// The drop folders are Documents/Import (the app's own, created at every launch: devicectl pushes there; with Finder or
// Files he puts files in it) and the system's Documents/Inbox (AirDrop and share-sheet copies; iOS reserves it, so the
// app reads and removes there but cannot create it).
// Import is listed first; the same file in both (name and size) is listed once, from Import; a missing folder lists
// nothing. A pack or atlas opened in place from Files is copied into Import first (`DropFolder.receive`).
// Installing, rolling back and rebuilding generations are M2 work: they answer NOT_IMPLEMENTED with what is missing,
// never a partial swap (installing a generation is the only way an atlas is replaced: a swap, never a merge).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsSources
import ScrollsStore

/// The statements of the platform half.
public enum PlatformSQL: SQLCatalog {
  static let installed = SQL("platform.installed", "SELECT pack_sha256, name FROM pack_install", scan: .scanOK(reason: "a handful of packs"))
  public static let all: [SQL] = [installed]
}

extension LiveAtlas {
  /// Atlas/packs: packs installed beside the atlas (STEMM, or cipher-text for a SCROLLS_BUNDLE_PACKS=0 install).
  var installedPacksDir: URL { location.atlasDir.appendingPathComponent("packs") }

  /// Bundled, installed and waiting packs (Import, then the system Inbox) with their verification state.
  @concurrent
  public func packs() async throws -> [PackStatus] {
    let (installed, state) = try await read { c in
      (try c.prepared(PlatformSQL.installed).all { (sha: $0.text(0), name: $0.text(1)) }, try BootstrapCipher.state(c))
    }
    let loadedSHAs = Set(installed.map(\.sha))
    var found: [(url: URL, location: PackStatus.Location, folder: DropFolder?)] = []
    if let b = launch.bundledResources {
      found += LiveAtlas.files(in: b, extension: PackFormat.fileExtension).map { ($0, .bundled, nil) }
    }
    found += LiveAtlas.files(in: installedPacksDir, extension: PackFormat.fileExtension).map { ($0, .installed, nil) }
    found += waitingFiles().filter { $0.url.lastPathComponent.hasSuffix(".\(PackFormat.fileExtension)") }.map { ($0.url, .inbox, $0.folder) }
    var out: [PackStatus] = []
    for (url, where_, folder) in found {
      let bytes = LiveAtlas.size(of: url)
      do {
        let reader = try PackReader(url: url)
        let m = reader.manifest
        // the sha256 is known without streaming the file when this process already opened it (PackLibrary caches it)
        let sha = where_ == .inbox ? nil : PackLibrary.cachedSHA256(url: url)
        var loaded = sha.map(loadedSHAs.contains) ?? installed.contains { $0.name == m.name }
        if m.name == CipherPacks.meta { loaded = loaded && BootstrapCipher.isDone(.a, state) }
        if m.name == CipherPacks.text { loaded = loaded && BootstrapCipher.isDone(.b, state) }
        out.append(PackStatus(name: m.name, version: m.version, sha256: sha, bytes: bytes, location: where_,
                              verification: sha != nil ? .verified : .unverified, loaded: loaded, folder: folder))
      } catch let e as ScrollsError {
        out.append(PackStatus(name: url.deletingPathExtension().lastPathComponent, version: "?", bytes: bytes, location: where_,
                              verification: .failed, loaded: false, problem: e.message, folder: folder))
      }
    }
    return out
  }

  /// Verifies a pack (whole-file sha256, streamed) and moves it into Atlas/packs. From a drop folder, the same name in the
  /// other drop folder is removed too when it is the same file (size and sha256), so both are emptied of what was
  /// installed; a different file of that name stays and is listed next.
  @concurrent
  public func installPack(_ url: URL) async throws -> PackStatus {
    let reader = try PackReader(url: url)
    let sha = try await reader.fileSHA256()
    let fm = FileManager.default
    try fm.createDirectory(at: installedPacksDir, withIntermediateDirectories: true)
    let dest = installedPacksDir.appendingPathComponent("\(reader.manifest.name).\(PackFormat.fileExtension)")
    if url.standardizedFileURL != dest.standardizedFileURL {
      let twins = twinPaths(of: url)
      if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
      try fm.moveItem(at: url, to: dest)
      for twin in twins where LiveAtlas.size(of: twin) == reader.fileSize {
        guard let other = try? PackReader(url: twin), (try? await other.fileSHA256()) == sha else { continue }
        try? fm.removeItem(at: twin)
      }
    }
    _ = try await PackLibrary.open(url: dest)
    return PackStatus(name: reader.manifest.name, version: reader.manifest.version, sha256: sha, bytes: LiveAtlas.size(of: dest),
                      location: .installed, verification: .verified, loaded: false)
  }

  /// What waits in the drop folders (Import first, then the system Inbox), with each item's folder and its compatibility
  /// in words (§3.5 step 1).
  @concurrent
  public func inbox() async throws -> [InboxItem] {
    var out: [InboxItem] = []
    for (url, folder) in waitingFiles() {
      let ext = Fold.asciiLowercased(url.pathExtension)
      let bytes = LiveAtlas.size(of: url)
      switch ext {
      case PackFormat.fileExtension:
        do {
          let m = try PackReader.readManifest(url: url)
          out.append(InboxItem(url: url, folder: folder, kind: .pack, bytes: bytes, compatible: true,
                               note: "\(m.name) \(m.version): \(Format.int(m.members.count)) files, slot \(m.slot.rawValue)"))
        } catch let e as ScrollsError {
          out.append(InboxItem(url: url, folder: folder, kind: .pack, bytes: bytes, compatible: false, note: e.message))
        }
      case "scrollsatlas", "scrollsarchive":
        out.append(InboxItem(url: url, folder: folder, kind: ext == "scrollsatlas" ? .atlas : .archive, bytes: bytes, compatible: false,
                             note: "Installing an atlas built on the Mac is not in this build of Scrolls yet; nothing was changed."))
      case "sqlite":
        out.append(InboxItem(url: url, folder: folder, kind: .baseline, bytes: bytes, compatible: false,
                             note: "The Ngram baseline is attached once the STEMM pack is loaded; this build does not load STEMM yet."))
      case "csv", "tsv", "json", "jsonl", "txt", "md":
        out.append(InboxItem(url: url, folder: folder, kind: .importFile, bytes: bytes, compatible: true,
                             note: "Import it with More → Import a file."))
      default:
        out.append(InboxItem(url: url, folder: folder, kind: .unknown, bytes: bytes, compatible: false,
                             note: "Scrolls has no reader for this kind of file."))
      }
    }
    return out
  }

  /// The current, next and previous generations (their ATLAS.json facts).
  @concurrent
  public func generations() async throws -> GenerationsStatus {
    let bytes = LiveAtlas.size(of: URL(fileURLWithPath: location.atlasPath)) + LiveAtlas.size(of: URL(fileURLWithPath: location.atlasPath + "-wal"))
    let current = try await read { c -> GenerationInfo in
      GenerationInfo(generation: try Meta.get(c, "generation") ?? "", engineVersion: try Meta.get(c, "engine_version") ?? BuildInfo.engineVersion,
                     journalSeq: UInt64(try Meta.get(c, "journal_applied_seq") ?? "0") ?? 0,
                     builtOn: try Meta.get(c, "generation_built_on") ?? Migrations.defaultBuiltOn,
                     builtAt: try Meta.get(c, "created_at") ?? "", bytes: bytes)
    }
    func other(_ dir: URL) -> GenerationInfo? {
      guard let m = try? GenerationManifest.read(at: dir.appendingPathComponent(GenerationManifest.fileName)) else { return nil }
      return GenerationInfo(generation: m.generation, engineVersion: m.engineVersion, journalSeq: m.journalSeq, builtOn: m.builtOn,
                            builtAt: m.builtAt, bytes: LiveAtlas.treeSize(dir))
    }
    return GenerationsStatus(current: current, next: other(location.nextDir), previous: other(location.prevDir))
  }

  /// Installs a `.scrollsatlas` / `.scrollsarchive` as a job: detect, free space, move, verify, catch up, swap.
  @concurrent
  public func installGeneration(_ url: URL) async throws -> JobID {
    throw ScrollsError.notImplemented(area: "Installing an atlas generation (detect, free space, move, verify, catch up, swap): M2, package N2")
  }

  /// Swaps back to Atlas.prev (one step).
  @concurrent
  public func rollbackGeneration() async throws {
    throw ScrollsError.notImplemented(area: "Rolling back to the previous atlas generation: M2, package N2")
  }

  /// Replays the starter, the packs and the journal into Atlas.next, then swaps.
  @concurrent
  public func rebuildGeneration() async throws -> JobID {
    throw ScrollsError.notImplemented(area: "Rebuilding the atlas into a new generation: M2, package N2")
  }

  /// The measured storage of the container by area, and the free space (§3.1).
  @concurrent
  public func storage() async throws -> StorageReport {
    let atlasFile = URL(fileURLWithPath: location.atlasPath)
    var areas: [String: Int64] = [
      "atlas": LiveAtlas.size(of: atlasFile) + LiveAtlas.size(of: URL(fileURLWithPath: location.atlasPath + "-wal"))
        + LiveAtlas.size(of: URL(fileURLWithPath: location.atlasPath + "-shm")),
      "derived": LiveAtlas.treeSize(location.derivedDir),
      "packs": LiveAtlas.treeSize(installedPacksDir),
      "caches": LiveAtlas.treeSize(location.cachesDir),
      "notebook": LiveAtlas.treeSize(location.notebookDir),
      "import": LiveAtlas.treeSize(location.importDir),
      "inbox": LiveAtlas.treeSize(location.inboxDir),
      "next": LiveAtlas.treeSize(location.nextDir),
      "prev": LiveAtlas.treeSize(location.prevDir),
    ]
    if let b = launch.bundledResources { areas["bundled"] = LiveAtlas.treeSize(b) }
    let values = try? location.atlasDir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return StorageReport(areas: areas, availableBytes: values?.volumeAvailableCapacityForImportantUsage ?? 0)
  }

  /// Deletes purgeable caches (cubes, token streams, tiles, thumbnails): everything under Library/Caches/Scrolls.
  @concurrent
  public func purgeCaches() async throws {
    let fm = FileManager.default
    for name in (try? fm.contentsOfDirectory(atPath: location.cachesDir.path)) ?? [] {
      try fm.removeItem(at: location.cachesDir.appendingPathComponent(name))
    }
  }

  // MARK: file helpers

  /// The files waiting in the drop folders, Documents/Import first, then the system's Documents/Inbox, each sorted by
  /// name with hidden files skipped. The same file in both (same name and size) is listed once, from Import (its Inbox
  /// twin shows once the Import copy is gone); two different files of one name are both listed, so a partial or damaged
  /// Import copy never hides a good one in the Inbox. A missing or unreadable folder lists nothing.
  func waitingFiles() -> [(url: URL, folder: DropFolder)] {
    var listed: [String: Int64] = [:]
    var out: [(url: URL, folder: DropFolder)] = []
    for folder in DropFolder.allCases {
      let dir = folder.url(in: location)
      for name in ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted() where !name.hasPrefix(".") {
        let url = dir.appendingPathComponent(name)
        let bytes = LiveAtlas.size(of: url)
        if listed[name] == bytes { continue }
        if listed[name] == nil { listed[name] = bytes }
        out.append((url, folder))
      }
    }
    return out
  }

  /// For a file in one drop folder, the paths of the same name in the others (empty for a file anywhere else).
  func twinPaths(of url: URL) -> [URL] {
    let dirs = DropFolder.allCases.map { $0.url(in: location) }
    let parent = url.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL
    guard let mine = dirs.firstIndex(where: { $0.resolvingSymlinksInPath().standardizedFileURL == parent }) else { return [] }
    return dirs.indices.filter { $0 != mine }.map { dirs[$0].appendingPathComponent(url.lastPathComponent) }
  }

  static func files(in dir: URL, extension ext: String) -> [URL] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    return names.filter { $0.hasSuffix(".\(ext)") && !$0.hasPrefix(".") }.sorted().map { dir.appendingPathComponent($0) }
  }

  static func size(of url: URL) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
  }

  /// Bytes of every regular file under `dir` (0 when it does not exist).
  static func treeSize(_ dir: URL) -> Int64 {
    guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) else { return 0 }
    var total: Int64 = 0
    for case let u as URL in e {
      let v = try? u.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
      if v?.isRegularFile == true { total += Int64(v?.fileSize ?? 0) }
    }
    return total
  }
}

extension DropFolder {
  /// Puts a pack or atlas that was opened in Scrolls (DeepLinks, `.packOrAtlas`) where the drop-folder scan lists it,
  /// and answers its URL there. Opened from Files it arrives in place (LSSupportsOpeningDocumentsInPlace): the original
  /// URL, outside the drop folders, which nothing lists. So: a file already in Documents/Import or the system Inbox
  /// (AirDrop's copy) stays; one elsewhere in Documents (a Finder drag onto Scrolls lands at its root) is moved into
  /// Import; one outside the container is copied in under security-scoped access and a coordinated read, to a hidden
  /// name first (the scan skips it) and then renamed, replacing a same-named file in Import. `documents` defaults to the
  /// app's Documents.
  @concurrent
  public static func receive(_ file: URL, documents: URL? = nil) async throws -> URL {
    let fm = FileManager.default
    let docs = try documents ?? fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    func canonical(_ u: URL) -> String { u.resolvingSymlinksInPath().standardizedFileURL.path }
    let importDir = docs.appendingPathComponent("Import", isDirectory: true)
    let parent = canonical(file.deletingLastPathComponent())
    if parent == canonical(importDir) || parent == canonical(docs.appendingPathComponent("Inbox")) { return file }
    try fm.createDirectory(at: importDir, withIntermediateDirectories: true)
    let dest = importDir.appendingPathComponent(file.lastPathComponent)
    if canonical(file).hasPrefix(canonical(docs) + "/") {
      if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
      try fm.moveItem(at: file, to: dest)
      return dest
    }
    let scoped = file.startAccessingSecurityScopedResource()
    defer { if scoped { file.stopAccessingSecurityScopedResource() } }
    let partial = importDir.appendingPathComponent(".receiving-\(file.lastPathComponent)")
    try? fm.removeItem(at: partial)
    var coordination: NSError?
    var copyError: (any Error)?
    NSFileCoordinator().coordinate(readingItemAt: file, options: [], error: &coordination) { readable in
      do { try fm.copyItem(at: readable, to: partial) } catch { copyError = error }
    }
    if let e = coordination ?? copyError.map({ $0 as NSError }) {
      try? fm.removeItem(at: partial)
      throw e
    }
    if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
    try fm.moveItem(at: partial, to: dest)
    return dest
  }
}
