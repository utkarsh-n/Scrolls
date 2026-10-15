// OWNER: N3
// Port of cache.mjs `sharedArtifact` (IOS-SPEC §1.3: cache.mjs becomes an in-memory LRU keyed by the inputs plus purgeable
// files). A value derived from the atlas — the slice cube, the label indexes, the maker-name index, transliteration groups —
// is built once per state of its inputs (`key`, evaluated once per data version) and kept in memory and, when the engine
// registered a cache directory for the atlas, in Caches/ (purgeable: losing a file costs one rebuild). A data-version bump
// that does not touch the inputs (a materialization) keeps the value.

import Foundation
import ScrollsCore
import ScrollsStore
import Synchronization

/// The engine's configuration for one atlas file.
public enum QueryEngine {
  private static let dirs = Mutex<[String: URL]>([:])

  /// Registers the purgeable cache directory of an atlas (idempotent). Without one, artifacts live in memory only.
  public static func register(atlasPath: String, cacheDirectory: URL) {
    dirs.withLock { $0[atlasPath] = cacheDirectory }
  }

  /// The cache directory registered for an atlas file.
  public static func cacheDirectory(for atlasPath: String) -> URL? { dirs.withLock { $0[atlasPath] } }
}

/// Shared, persisted artifacts.
public enum Artifacts {
  final class Box: @unchecked Sendable {
    let value: Any
    init(_ value: Any) { self.value = value }
  }

  private struct State {
    var values: [String: (box: Box, tick: UInt64)] = [:]
    var keys: [String: String] = [:]
    var tick: UInt64 = 0
  }

  private static let state = Mutex(State())
  /// Artifacts kept in memory (the reference keeps 96).
  static let capacity = 96
  /// Serialises builds of the same artifact (a second reader waits instead of scanning again).
  private static let building = Mutex<Set<String>>([])

  /// Forgets every in-memory artifact (a memory warning; files stay).
  public static func trimMemory() { state.withLock { $0 = State() } }

  /// The identity of an atlas for cache files: a fresh atlas never reads an older one's files.
  static func dbTag(_ c: Connection) throws -> String {
    IDs.shortHash("\(try Meta.get(c, "created_at") ?? "")|\(try Meta.get(c, "schema_version") ?? "")", length: 8)
  }

  /// The inputs key of an artifact, evaluated once per data version.
  static func inputsKey(_ c: Connection, name: String, key: (Connection) throws -> String) throws -> String {
    let dv = try Meta.dataVersion(c)
    let memo = "\(c.path)|\(name)|v\(dv)"
    if let k = state.withLock({ $0.keys[memo] }) { return k }
    let k = try key(c)
    state.withLock { s in
      if s.keys.count > 2000 { s.keys.removeAll() }
      s.keys[memo] = k
    }
    return k
  }

  private static func memoryGet(_ k: String) -> Box? {
    state.withLock { s in
      guard let e = s.values[k] else { return nil }
      s.tick &+= 1
      s.values[k] = (e.box, s.tick)
      return e.box
    }
  }

  private static func memoryPut(_ k: String, _ box: Box) {
    state.withLock { s in
      s.tick &+= 1
      s.values[k] = (box, s.tick)
      while s.values.count > capacity, let victim = s.values.min(by: { $0.value.tick < $1.value.tick })?.key {
        s.values[victim] = nil
      }
    }
  }

  /// A Codable artifact: memory → `<cache dir>/<name>-<tag>-<key>.json` → build.
  public static func shared<T: Codable & Sendable>(_ c: Connection, name: String, key: (Connection) throws -> String,
                                                   build: (Connection) throws -> T) throws -> T {
    try sharedValue(c, name: name, key: key, build: build,
                    encode: { try JSONEncoder().encode($0) }, decode: { try JSONDecoder().decode(T.self, from: $0) }, ext: "json")
  }

  /// An artifact with its own file form (the cube's columns).
  /// `mappedDecode` reads a cache file in place (a mapping) instead of through `Data`; after a build the fresh file is
  /// mapped too, so the built copy's dirty pages are released.
  public static func sharedValue<T: Sendable>(_ c: Connection, name: String, key: (Connection) throws -> String,
                                              build: (Connection) throws -> T, encode: (T) throws -> Data,
                                              decode: (Data) throws -> T, mappedDecode: ((URL) throws -> T)? = nil,
                                              ext: String = "bin") throws -> T {
    let tag = try dbTag(c)
    let k = try inputsKey(c, name: name, key: key)
    let memKey = "\(c.path)|\(name)-\(tag)|\(k)"
    if let hit = memoryGet(memKey), let v = hit.value as? T { return v }
    let dir = QueryEngine.cacheDirectory(for: c.path)
    let file = dir?.appendingPathComponent("\(name)-\(tag)-\(k).\(ext)")
    if let file, FileManager.default.fileExists(atPath: file.path) {
      let v: T? = mappedDecode.flatMap { try? $0(file) }
        ?? (try? Data(contentsOf: file, options: .alwaysMapped)).flatMap { try? decode($0) }
      if let v {
        memoryPut(memKey, Box(v))
        return v
      }
      try? FileManager.default.removeItem(at: file)
    }
    var v = try build(c)
    if let dir, let file {
      do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tmp = dir.appendingPathComponent(".\(UUID().uuidString).tmp")
        try encode(v).write(to: tmp)
        _ = try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: tmp, to: file)
        prune(dir, base: "\(name)-\(tag)-", keep: file.lastPathComponent)
        if let mappedDecode, let mapped = try? mappedDecode(file) { v = mapped }
      } catch {
        // a full or read-only disk only costs a rebuild next time
      }
    }
    memoryPut(memKey, Box(v))
    return v
  }

  /// The artifact when it is in memory or on disk, never building it (`peekArtifact`).
  public static func peek<T: Sendable>(_ c: Connection, name: String, key: (Connection) throws -> String,
                                       decode: (Data) throws -> T, ext: String = "bin") throws -> T? {
    let tag = try dbTag(c)
    let k = try inputsKey(c, name: name, key: key)
    let memKey = "\(c.path)|\(name)-\(tag)|\(k)"
    if let hit = memoryGet(memKey), let v = hit.value as? T { return v }
    guard let dir = QueryEngine.cacheDirectory(for: c.path) else { return nil }
    let file = dir.appendingPathComponent("\(name)-\(tag)-\(k).\(ext)")
    guard let data = try? Data(contentsOf: file, options: .alwaysMapped), let v = try? decode(data) else { return nil }
    memoryPut(memKey, Box(v))
    return v
  }

  /// Removes older versions of an artifact of the same atlas.
  private static func prune(_ dir: URL, base: String, keep: String) {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
    for n in names where n != keep && n.hasPrefix(base) {
      try? FileManager.default.removeItem(at: dir.appendingPathComponent(n))
    }
  }
}
