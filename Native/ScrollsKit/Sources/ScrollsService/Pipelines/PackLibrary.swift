// OWNER: N2
// Where a load finds its packs by name (IOS-SPEC §3.5, §3.9): directories the CLI or a test names, the atlas's own
// `Atlas/packs/` (installed packs: STEMM, or cipher-text for a SCROLLS_BUNDLE_PACKS=0 install), then the app bundle's
// `Bundled/` (cipher-meta and cipher-text). Jobs carry pack names, never paths (a bundle path changes with every
// install), so a resumed job finds the same packs again. The whole-file sha256 of each pack is computed by streaming
// the first time it is opened in this process (and checked against `pack_install` when the atlas recorded one).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsSources
import ScrollsStore
import Synchronization

/// The packs this process can read.
public enum PackLibrary {
  private struct Opened: Sendable {
    let path: String
    let size: Int64
    let mtime: Date
    let pack: SourceFiles.Pack
  }

  private static let state = Mutex<(extra: [URL], opened: [String: Opened])>(([], [:]))

  /// Directories searched first (the CLI's `--packs`, tests).
  public static func addSearchDirectory(_ url: URL) {
    state.withLock { s in if !s.extra.contains(url) { s.extra.insert(url, at: 0) } }
  }

  /// Forgets the extra directories and the opened packs (tests).
  public static func reset() { state.withLock { $0 = ([], [:]) } }

  /// The directories searched for `<name>.scrollspack`, in order.
  public static func searchDirectories(atlasPath: String?) -> [URL] {
    var dirs = state.withLock { $0.extra }
    if let atlasPath { dirs.append(URL(fileURLWithPath: atlasPath).deletingLastPathComponent().appendingPathComponent("packs")) }
    if let bundled = Bundle.main.resourceURL?.appendingPathComponent("Bundled") { dirs.append(bundled) }
    return dirs
  }

  /// The file of pack `name`, if any search directory holds one.
  public static func url(of name: String, atlasPath: String?) -> URL? {
    let fm = FileManager.default
    for d in searchDirectories(atlasPath: atlasPath) {
      let u = d.appendingPathComponent("\(name).\(PackFormat.fileExtension)")
      if fm.fileExists(atPath: u.path) { return u }
    }
    return nil
  }

  /// Opens pack `name` (its sha256 streamed once per file per process); nil when it is not on this device.
  public static func open(_ name: String, atlasPath: String?) async throws -> SourceFiles.Pack? {
    guard let url = url(of: name, atlasPath: atlasPath) else { return nil }
    return try await open(url: url)
  }

  /// Opens the pack at `url` (sha256 cached by path, size and modification time).
  public static func open(url: URL) async throws -> SourceFiles.Pack {
    let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
    let size = (attrs[.size] as? NSNumber)?.int64Value ?? -1
    let mtime = attrs[.modificationDate] as? Date ?? .distantPast
    if let hit = state.withLock({ $0.opened[url.path] }), hit.size == size, hit.mtime == mtime { return hit.pack }
    let reader = try PackReader(url: url)
    let sha = try await reader.fileSHA256()
    let pack = SourceFiles.Pack(reader: reader, sha256: sha)
    state.withLock { $0.opened[url.path] = Opened(path: url.path, size: size, mtime: mtime, pack: pack) }
    return pack
  }

  /// The whole-file sha256 of the pack at `url` if this process already streamed it (and the file is unchanged since).
  public static func cachedSHA256(url: URL) -> String? {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
    let size = (attrs[.size] as? NSNumber)?.int64Value ?? -1
    let mtime = attrs[.modificationDate] as? Date ?? .distantPast
    guard let hit = state.withLock({ $0.opened[url.path] }), hit.size == size, hit.mtime == mtime else { return nil }
    return hit.pack.sha256
  }

  /// The packs `names` (in order) as one `SourceFiles`; throws a named E_PACK_ABSENT for a missing one.
  public static func files(_ names: [String], atlasPath: String?) async throws -> SourceFiles {
    var packs: [SourceFiles.Pack] = []
    for n in names {
      guard let p = try await open(n, atlasPath: atlasPath) else { throw absent(n) }
      packs.append(p)
    }
    return SourceFiles(packs)
  }

  public static let absentCode = ErrorCode(rawValue: "E_PACK_ABSENT")

  /// "The <name> pack is not on this phone" with how to send it.
  public static func absent(_ name: String) -> ScrollsError {
    ScrollsError(code: absentCode, message: "The \(name) source pack is not on this phone.",
                 hint: name.hasPrefix("cipher")
                   ? "It ships in the app; build the app with Tools/packs.sh run first (or push it: Tools/atlas.sh push-pack \(name))."
                   : "On your Mac: Tools/atlas.sh push-pack \(name) — or put \(name).scrollspack in Scrolls' Import folder (Finder, Files) — or AirDrop it.",
                 detail: ["pack": .string(name)], status: 409)
  }
}
