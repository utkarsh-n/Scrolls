// OWNER: N2
// The member files an adapter reads (ΔS-5, ΔS-6): one or more source packs, resolved by member path in the order
// given (cipher-meta first, then cipher-text). Every member read through here is checked against its manifest
// sha256 the first time it is read in full (PackReader). `keep(_:)` is the phone's `keepOriginal`: instead of copying
// a file into originals/, it records the member, and the pipeline writes its `original_file` row
// (`rel_path = 'pack:<name>@<sha8>/<member>'`, IOS-SPEC §3.5) before any document points at it.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore
import Synchronization

/// An `original_file` row for a pack member.
public struct SourceOriginal: Sendable, Hashable {
  public var sha256: String
  /// `pack:<name>@<sha8>/<member>`.
  public var relPath: String
  /// The member path inside its pack (informational, like the reference's source path).
  public var sourcePath: String
  public var byteSize: Int64
  public var encoding: String
  public var hadBOM: Bool

  public init(sha256: String, relPath: String, sourcePath: String, byteSize: Int64, encoding: String = "utf-8",
              hadBOM: Bool) {
    self.sha256 = sha256
    self.relPath = relPath
    self.sourcePath = sourcePath
    self.byteSize = byteSize
    self.encoding = encoding
    self.hadBOM = hadBOM
  }
}

/// The packs an adapter reads its members from.
public struct SourceFiles: Sendable {
  /// One opened pack and the sha256 of its whole file (verified at install, or at its first load for a bundled pack).
  public struct Pack: Sendable {
    public let reader: PackReader
    public let sha256: String
    public init(reader: PackReader, sha256: String) {
      self.reader = reader
      self.sha256 = sha256
    }
    public var name: String { reader.manifest.name }
  }

  public let packs: [Pack]
  private let kept: KeptOriginals

  public init(_ packs: [Pack]) {
    self.packs = packs
    self.kept = KeptOriginals()
  }

  /// No packs: every adapter that needs one probes as unavailable.
  public static var none: SourceFiles { SourceFiles([]) }

  /// The pack holding `member`, first match in order.
  public func pack(holding member: String) -> Pack? { packs.first { $0.reader.contains(member) } }

  public func contains(_ member: String) -> Bool { pack(holding: member) != nil }

  /// The member's manifest facts.
  public func info(_ member: String) -> PackMemberInfo? { pack(holding: member)?.reader.info(member) }

  /// Every member path under `prefix` (in pack order, first pack first, no duplicates).
  public func members(prefix: String) -> [String] {
    var seen = Set<String>(), out: [String] = []
    for p in packs {
      for m in p.reader.memberPaths where m.hasPrefix(prefix) && seen.insert(m).inserted { out.append(m) }
    }
    return out
  }

  /// The member's whole bytes (checked against its sha256 on the first full read).
  public func data(_ member: String) throws -> Data {
    guard let p = pack(holding: member) else { throw SourceFilesError.missing(member, in: packs.map(\.name)) }
    return try p.reader.data(member: member)
  }

  /// `keepOriginal`: records the member as an original of this load and returns its sha256.
  @discardableResult
  public func keep(_ member: String) throws -> String {
    guard let p = pack(holding: member), let info = p.reader.info(member) else {
      throw SourceFilesError.missing(member, in: packs.map(\.name))
    }
    let head = info.size >= 3 ? try p.reader.bytes(member: member, range: 0..<3) : Data()
    let bom = head.count == 3 && head[head.startIndex] == 0xEF && head[head.startIndex + 1] == 0xBB && head[head.startIndex + 2] == 0xBF
    kept.add(SourceOriginal(sha256: info.sha256, relPath: p.reader.originalPath(member: member, packSHA256: p.sha256),
                            sourcePath: member, byteSize: info.size, hadBOM: bom))
    return info.sha256
  }

  /// The originals kept since the last drain (the pipeline writes their rows before the documents that cite them).
  public func drainKept() -> [SourceOriginal] { kept.drain() }
}

/// Members kept by adapters, waiting for their `original_file` rows.
final class KeptOriginals: Sendable {
  private let state = Mutex<(pending: [SourceOriginal], seen: Set<String>)>(([], []))
  func add(_ o: SourceOriginal) {
    state.withLock { s in
      if s.seen.insert(o.sha256).inserted { s.pending.append(o) }
    }
  }
  func drain() -> [SourceOriginal] {
    state.withLock { s in
      defer { s.pending = [] }
      return s.pending
    }
  }
}

/// Why a member cannot be read.
public enum SourceFilesError {
  public static let code = ErrorCode(rawValue: "E_PACK_MEMBER")
  public static func missing(_ member: String, in packs: [String]) -> ScrollsError {
    ScrollsError(code: code,
                 message: packs.isEmpty ? "No source pack holding '\(member)' is on this phone."
                   : "None of the packs \(packs.joined(separator: ", ")) holds '\(member)'.",
                 hint: "Build the packs again with Tools/packs.sh from the same commit.", status: 404)
  }
}
