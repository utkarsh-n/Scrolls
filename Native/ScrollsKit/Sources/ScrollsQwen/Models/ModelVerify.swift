// OWNER: Q (created by the bring-up, B2)
// sha256 verification of a pushed model folder (IOS-SPEC-QWEN §2.2 `ModelVerify`, §2.10). Every file is streamed
// through CryptoKit in 1 MiB reads and compared with the catalogue compiled into the app; a model is never loaded
// from a folder that has not passed. A pass is remembered in `.scrolls-verified.json` (sizes and modification times),
// so a later launch re-hashes only when a file changed; the screen says which happened.

import CryptoKit
import Foundation

public struct ModelFileCheck: Codable, Sendable, Equatable {
  public enum Status: String, Codable, Sendable { case ok, missing, wrongSize, wrongSHA }
  public var name: String
  public var status: Status
  public var bytes: Int?
  public var sha256: String?
}

public struct ModelVerification: Codable, Sendable, Equatable {
  public var model: String
  public var role: ModelRole
  public var folder: String
  public var ok: Bool
  /// true when every file was hashed now; false when the stored stamp matched every file's size and mtime.
  public var hashedNow: Bool
  public var seconds: Double
  public var verifiedAt: String
  public var files: [ModelFileCheck]

  public var summary: String {
    // rule 25: the word "verified" never appears in the UI, so file checks say what was compared
    if ok { return hashedNow ? "sha256 matches the catalogue (\(files.count) files)" : "sha256 matched earlier; files unchanged since" }
    let bad = files.filter { $0.status != .ok }
    return "sha256 does not match the catalogue: " + bad.map { "\($0.name) \($0.status.rawValue)" }.joined(separator: ", ")
  }
}

public enum ModelVerify {
  public static let stampName = ".scrolls-verified.json"
  static let chunk = 1 << 20

  struct Stamp: Codable, Equatable {
    var model: String
    var sha256: String
    var files: [String: [Double]]   // name → [bytes, mtime seconds]
    var verifiedAt: String
  }

  /// Verifies `folder` against `spec`. `force` re-hashes even when the stamp matches.
  public static func verify(folder: URL, spec: ModelSpec, force: Bool = false,
                            progress: @Sendable (Double) -> Void = { _ in }) -> ModelVerification {
    let fm = FileManager.default
    let t0 = Date()
    var stat: [String: (bytes: Int, mtime: Double)] = [:]
    for f in spec.files {
      let url = folder.appendingPathComponent(f.name)
      if let a = try? fm.attributesOfItem(atPath: url.path), let size = (a[.size] as? NSNumber)?.intValue {
        stat[f.name] = (size, (a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)
      }
    }
    let stampURL = folder.appendingPathComponent(stampName)
    if !force, let data = try? Data(contentsOf: stampURL), let stamp = try? JSONDecoder().decode(Stamp.self, from: data),
       stamp.sha256 == spec.sha256,
       spec.files.allSatisfy({ f in
         guard let s = stat[f.name], let rec = stamp.files[f.name], rec.count == 2 else { return false }
         return s.bytes == f.bytes && Double(s.bytes) == rec[0] && abs(s.mtime - rec[1]) < 0.001
       }) {
      return ModelVerification(model: spec.name, role: spec.role, folder: folder.path, ok: true, hashedNow: false,
                               seconds: Date().timeIntervalSince(t0), verifiedAt: stamp.verifiedAt,
                               files: spec.files.map { ModelFileCheck(name: $0.name, status: .ok, bytes: $0.bytes, sha256: $0.sha256) })
    }
    let total = max(1, spec.files.reduce(0) { $0 + $1.bytes })
    var done = 0
    var checks: [ModelFileCheck] = []
    for f in spec.files {
      guard let s = stat[f.name] else {
        checks.append(ModelFileCheck(name: f.name, status: .missing, bytes: nil, sha256: nil))
        continue
      }
      guard s.bytes == f.bytes else {
        checks.append(ModelFileCheck(name: f.name, status: .wrongSize, bytes: s.bytes, sha256: nil))
        done += f.bytes
        continue
      }
      let base = done
      let digest = sha256(of: folder.appendingPathComponent(f.name)) { n in progress(Double(base + n) / Double(total)) }
      done += f.bytes
      checks.append(ModelFileCheck(name: f.name, status: digest == f.sha256 ? .ok : .wrongSHA, bytes: s.bytes, sha256: digest))
    }
    let ok = checks.allSatisfy { $0.status == .ok }
    let at = ISO8601DateFormatter().string(from: Date())
    if ok {
      let stamp = Stamp(model: spec.name, sha256: spec.sha256,
                        files: Dictionary(uniqueKeysWithValues: spec.files.compactMap { f in
                          stat[f.name].map { (f.name, [Double($0.bytes), $0.mtime]) } }),
                        verifiedAt: at)
      if let data = try? JSONEncoder().encode(stamp) { try? data.write(to: stampURL, options: .atomic) }
    } else {
      try? fm.removeItem(at: stampURL)
    }
    return ModelVerification(model: spec.name, role: spec.role, folder: folder.path, ok: ok, hashedNow: true,
                             seconds: Date().timeIntervalSince(t0), verifiedAt: at, files: checks)
  }

  /// Hex sha256 of a file, streamed in 1 MiB reads; nil when it cannot be read.
  public static func sha256(of url: URL, read: (Int) -> Void = { _ in }) -> String? {
    guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? h.close() }
    var hasher = SHA256()
    var n = 0
    while true {
      let ok: Bool = autoreleasepool {
        guard let data = try? h.read(upToCount: chunk), !data.isEmpty else { return false }
        hasher.update(data: data)
        n += data.count
        return true
      }
      if !ok { break }
      read(n)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /// The MANIFEST.json `Tools/models.sh` pushes beside a model (the same values as the catalogue).
  public static func manifest(_ spec: ModelSpec) -> Data {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    return (try? enc.encode(spec)) ?? Data()
  }
}
