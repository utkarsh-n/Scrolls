// OWNER: N0
// Where an atlas and its notebook live (IOS-SPEC §3.9, §6.6; the analogue of the reference's config.mjs paths).
// The live atlas is in Application Support (excluded from backup, protected until first unlock); the notebook beside
// it is backed up; nothing precious is in Documents (visible in Files) and nothing is in an App Group (0xdead10cc).
// `-atlasRoot` self-tests get an isolated root with their own Atlas/ and Notebook/. The CLI keeps the reference's
// E_DB_IN_ICLOUD refusal.

import Foundation
import ScrollsContracts

/// The directories of one atlas root.
public struct AtlasLocation: Sendable, Equatable {
  public let atlasDir: URL
  public let nextDir: URL
  public let prevDir: URL
  public let notebookDir: URL
  public let derivedDir: URL
  public let cachesDir: URL
  /// Documents/Import: the app's own drop folder for packs, atlases and import files (devicectl pushes; Finder, Files).
  /// Created at every launch, best effort (it holds nothing precious: if something else sits at that name the engine
  /// still opens and the scan reads it as empty); listed before the system Inbox.
  public let importDir: URL
  /// Documents/Inbox: the system's drop folder (AirDrop and share-sheet copies). iOS reserves it: the app may read and
  /// remove there but cannot create or write it, so it may not exist (an empty one to the scan).
  public let inboxDir: URL
  public let diagnosticsDir: URL
  /// Documents/selftest (result.json files that device-check.sh pulls).
  public let selfTestResultsDir: URL

  /// `Atlas/atlas.sqlite`.
  public var atlasPath: String { atlasDir.appendingPathComponent("atlas.sqlite").path }

  /// The live atlas of the app's container.
  public static func live() throws -> AtlasLocation {
    let fm = FileManager.default
    let support = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let documents = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let caches = try fm.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let loc = AtlasLocation(support: support, documents: documents, caches: caches.appendingPathComponent("Scrolls"))
    try loc.prepare()
    return loc
  }

  /// An isolated root for a self-test run: `Application Support/SelfTest/<name>-<run>/` with its own Atlas/ and
  /// Notebook/. With `cloneLive`, the live atlas is APFS-cloned in as the starting state (the journal starts empty).
  public static func selfTest(_ name: String, cloneLive: Bool) throws -> AtlasLocation {
    let fm = FileManager.default
    let support = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let documents = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let caches = try fm.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let run = StoreClock.isoNow().replacingOccurrences(of: ":", with: "").replacingOccurrences(of: ".", with: "")
    let root = support.appendingPathComponent("SelfTest").appendingPathComponent("\(name)-\(run)")
    let loc = AtlasLocation(support: root, documents: documents, caches: caches.appendingPathComponent("Scrolls/SelfTest/\(name)-\(run)"))
    try loc.prepare()
    if cloneLive { try loc.cloneAtlas(from: try live()) }
    return loc
  }

  /// A root for the CLI and tests: `<root>/{Atlas,Atlas.next,Atlas.prev,Notebook,Documents,Caches}`. Refuses iCloud
  /// paths (E_DB_IN_ICLOUD), as the reference does.
  public static func at(root: URL) throws -> AtlasLocation {
    try refuseICloud(root)
    let loc = AtlasLocation(support: root, documents: root.appendingPathComponent("Documents"),
                            caches: root.appendingPathComponent("Caches"))
    try loc.prepare()
    return loc
  }

  init(support: URL, documents: URL, caches: URL) {
    atlasDir = support.appendingPathComponent("Atlas")
    nextDir = support.appendingPathComponent("Atlas.next")
    prevDir = support.appendingPathComponent("Atlas.prev")
    notebookDir = support.appendingPathComponent("Notebook")
    derivedDir = atlasDir.appendingPathComponent("derived")
    cachesDir = caches
    importDir = documents.appendingPathComponent("Import")
    inboxDir = documents.appendingPathComponent("Inbox")
    diagnosticsDir = documents.appendingPathComponent("Diagnostics")
    selfTestResultsDir = documents.appendingPathComponent("selftest")
  }

  /// Creates the directories and sets backup exclusion and file protection.
  func prepare() throws {
    let fm = FileManager.default
    for d in [atlasDir, derivedDir, notebookDir, cachesDir, diagnosticsDir] {
      try fm.createDirectory(at: d, withIntermediateDirectories: true)
    }
    // The drop folders are best effort: neither holds anything precious, and failing to make one must never leave the
    // app without an engine. Documents/Inbox is reserved on iOS: the system creates it to deliver AirDrop and share-sheet
    // files, and an app may read and remove from it but not create it (NSCocoaErrorDomain 513 on his iPhone, which left
    // no engine at all). Documents/Import is the app's own and is made at every launch; it fails only when something
    // else sits at that name in Documents (a file he put there), and the scan then reads it as empty.
    try? fm.createDirectory(at: importDir, withIntermediateDirectories: true)
    try? fm.createDirectory(at: inboxDir, withIntermediateDirectories: true)
    try AtlasLocation.excludeFromBackup(atlasDir)
    try AtlasLocation.excludeFromBackup(cachesDir)
    #if os(iOS)
      try fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: atlasDir.path)
    #endif
  }

  /// Marks a directory as not backed up (the atlas is rebuilt from the notebook after a restore).
  public static func excludeFromBackup(_ url: URL) throws {
    var u = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try u.setResourceValues(values)
  }

  /// Clones `atlas.sqlite` (with its WAL) and ATLAS.json of `source` into this root (APFS clonefile through copyItem).
  func cloneAtlas(from source: AtlasLocation) throws {
    let fm = FileManager.default
    for name in ["atlas.sqlite", "atlas.sqlite-wal", "ATLAS.json"] {
      let from = source.atlasDir.appendingPathComponent(name)
      guard fm.fileExists(atPath: from.path) else { continue }
      let to = atlasDir.appendingPathComponent(name)
      try? fm.removeItem(at: to)
      try fm.copyItem(at: from, to: to)
    }
  }

  /// E_DB_IN_ICLOUD for paths under iCloud Drive or a synced Documents/Desktop folder.
  public static func refuseICloud(_ url: URL) throws {
    let path = url.standardizedFileURL.resolvingSymlinksInPath().path
    let home = NSHomeDirectory()
    let synced = ["\(home)/Library/Mobile Documents", "\(home)/Documents", "\(home)/Desktop"]
    if synced.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) {
      throw ScrollsError(code: .dbInICloud,
                         message: "The atlas would live in an iCloud-synced folder (\(path)).",
                         hint: "Use a folder outside iCloud, e.g. ~/Developer/scrolls-atlas.", detail: nil)
    }
  }
}
