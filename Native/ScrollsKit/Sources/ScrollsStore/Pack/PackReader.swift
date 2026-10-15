// OWNER: N2
// Reads a `.scrollspack` (IOS-SPEC §3.5, §8.4.4; layout in PackWriter.swift and Native/Docs/PACK-FORMAT.md): the magic
// `SCROLLSPACK\u{1}`, the canonical-JSON manifest, the member index with its frame table, and each member's bytes in
// 1 MiB LZFSE frames. `bytes(member:range:)` decodes only the covering frames. The whole file's sha256 is checked by
// streaming (CryptoKit) at install; a member's sha256 the first time it is read in full (`data(member:)`, `verify`).
// Reads are positional (`pread`) on one descriptor, so adapters may read members from several tasks at once.

import Compression
import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore
import Synchronization

/// A source pack opened for reading (thread-safe: adapters read members from several tasks).
public final class PackReader: Sendable {
  /// The pack's manifest, read at open.
  public let manifest: PackManifest
  /// Where the pack is.
  public let url: URL
  /// The file's size in bytes.
  public let fileSize: Int64

  struct Entry: Sendable {
    let info: PackMemberInfo
    /// Absolute file offset of each frame, and its stored length.
    let frames: [(offset: Int64, stored: Int)]
  }

  private let fd: Int32
  private let entries: [String: Entry]
  private let order: [String]
  /// Members whose full bytes already hashed to their manifest sha256.
  private let verified = Mutex<Set<String>>([])

  /// Opens the pack at `url` and reads its manifest and member index.
  public init(url: URL) throws {
    self.url = url
    let fd = open(url.path, O_RDONLY)
    guard fd >= 0 else { throw PackError.invalid("cannot open \(url.lastPathComponent) (errno \(errno))") }
    do {
      var st = stat()
      guard fstat(fd, &st) == 0 else { throw PackError.invalid("cannot stat \(url.lastPathComponent)") }
      let size = Int64(st.st_size)
      let head = try PackReader.readHead(fd: fd, fileSize: size)
      self.manifest = head.manifest
      self.entries = head.entries
      self.order = head.order
      self.fileSize = size
      self.fd = fd
    } catch {
      close(fd)
      throw error
    }
  }

  deinit { close(fd) }

  /// Only the manifest of the pack at `url` (the inbox lists packs without opening their index).
  public static func readManifest(url: URL) throws -> PackManifest {
    try PackReader(url: url).manifest
  }

  // MARK: members

  /// Every member path, in pack order.
  public var memberPaths: [String] { order }

  /// The member's manifest facts, if the pack has it.
  public func info(_ member: String) -> PackMemberInfo? { entries[member]?.info }

  /// Whether the pack has `member`.
  public func contains(_ member: String) -> Bool { entries[member] != nil }

  /// The sha256 of the whole file, streamed.
  public func fileSHA256() async throws -> String {
    var hasher = SHA256()
    var offset: Int64 = 0
    let step = 4 << 20
    var buffer = [UInt8](repeating: 0, count: step)
    while offset < fileSize {
      let n = try readExactly(into: &buffer, count: Int(min(Int64(step), fileSize - offset)), at: offset)
      hasher.update(data: buffer[0..<n])
      offset += Int64(n)
      if offset % (64 << 20) == 0 { await Task.yield() }
      try Task.checkCancellation()
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /// The bytes of `member` in `range` (uncompressed offsets); decodes only the covering 1 MiB frames.
  public func bytes(member: String, range: Range<Int64>) throws -> Data {
    guard let e = entries[member] else { throw PackError.noMember(member, pack: manifest.name) }
    let lo = max(0, range.lowerBound), hi = min(e.info.size, range.upperBound)
    guard lo < hi else { return Data() }
    let f = Int64(PackFormat.frameSize)
    var out = Data()
    out.reserveCapacity(Int(hi - lo))
    for k in Int(lo / f)...Int((hi - 1) / f) {
      let frame = try decodeFrame(e, k)
      let frameStart = Int64(k) * f
      let a = Int(max(lo, frameStart) - frameStart), b = Int(min(hi, frameStart + Int64(frame.count)) - frameStart)
      out.append(frame[a..<b])
    }
    return out
  }

  /// The member's whole bytes; the first full read checks them against the manifest sha256.
  public func data(member: String) throws -> Data {
    guard let e = entries[member] else { throw PackError.noMember(member, pack: manifest.name) }
    var out = Data()
    out.reserveCapacity(Int(e.info.size))
    for k in e.frames.indices { out.append(try decodeFrame(e, k)) }
    if !verified.withLock({ $0.contains(member) }) {
      let sha = SHA256.hash(data: out).map { String(format: "%02x", $0) }.joined()
      guard sha == e.info.sha256 else {
        throw PackError.checksum("Member '\(member)' of the pack '\(manifest.name)'", expected: e.info.sha256, got: sha)
      }
      verified.withLock { _ = $0.insert(member) }
    }
    return out
  }

  /// The member's bytes, frame by frame.
  public func stream(member: String) -> AsyncThrowingStream<Data, any Error> {
    guard let e = entries[member] else {
      return AsyncThrowingStream { $0.finish(throwing: PackError.noMember(member, pack: manifest.name)) }
    }
    let frames = e.frames.indices
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          for k in frames {
            try Task.checkCancellation()
            continuation.yield(try self.decodeFrame(e, k))
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  /// Whether the member's bytes hash to its manifest sha256.
  public func verify(member: String) async throws -> Bool {
    guard let e = entries[member] else { throw PackError.noMember(member, pack: manifest.name) }
    if verified.withLock({ $0.contains(member) }) { return true }
    var hasher = SHA256()
    for k in e.frames.indices {
      hasher.update(data: try decodeFrame(e, k))
      if k % 64 == 63 { await Task.yield() }
    }
    let ok = hasher.finalize().map { String(format: "%02x", $0) }.joined() == e.info.sha256
    if ok { verified.withLock { _ = $0.insert(member) } }
    return ok
  }

  /// `pack:<name>@<sha8>/<member>`: the `original_file.rel_path` of a document loaded from this pack (§3.5).
  public func originalPath(member: String, packSHA256: String) -> String {
    "pack:\(manifest.name)@\(packSHA256.prefix(8))/\(member)"
  }

  // MARK: reading

  private func decodeFrame(_ e: Entry, _ k: Int) throws -> Data {
    let (offset, stored) = e.frames[k]
    let raw = Int(min(Int64(PackFormat.frameSize), e.info.size - Int64(k) * Int64(PackFormat.frameSize)))
    var src = [UInt8](repeating: 0, count: stored)
    _ = try readExactly(into: &src, count: stored, at: offset)
    if stored == raw { return Data(src) }
    var dst = [UInt8](repeating: 0, count: raw)
    let n = src.withUnsafeBufferPointer { s in
      dst.withUnsafeMutableBufferPointer { d in
        compression_decode_buffer(d.baseAddress!, d.count, s.baseAddress!, s.count, nil, COMPRESSION_LZFSE)
      }
    }
    guard n == raw else {
      throw PackError.invalid("frame \(k) of member '\(e.info.path)' decodes to \(n) bytes instead of \(raw)")
    }
    return Data(dst)
  }

  private func readExactly(into buffer: inout [UInt8], count: Int, at offset: Int64) throws -> Int {
    try PackReader.pread(fd, &buffer, count, offset)
  }

  private static func pread(_ fd: Int32, _ buffer: inout [UInt8], _ count: Int, _ offset: Int64) throws -> Int {
    var done = 0
    try buffer.withUnsafeMutableBytes { p in
      while done < count {
        let n = Darwin.pread(fd, p.baseAddress! + done, count - done, off_t(offset + Int64(done)))
        if n < 0 {
          if errno == EINTR { continue }
          throw PackError.invalid("read failed at byte \(offset + Int64(done)) (errno \(errno))")
        }
        if n == 0 { throw PackError.invalid("the file ends at byte \(offset + Int64(done)), before its frames do") }
        done += n
      }
    }
    return done
  }

  private static func readHead(fd: Int32, fileSize: Int64) throws
    -> (manifest: PackManifest, entries: [String: Entry], order: [String])
  {
    var magic = [UInt8](repeating: 0, count: PackFormat.magic.count)
    guard fileSize >= Int64(PackFormat.magic.count + 16) else { throw PackError.invalid("the file is too short") }
    _ = try pread(fd, &magic, magic.count, 0)
    guard magic == PackFormat.magic else {
      if Array(magic.prefix(11)) == Array(PackFormat.magic.prefix(11)) {
        throw PackError.invalid("format version \(magic[11]) is not one this engine reads (SPK1)")
      }
      throw PackError.invalid("the file does not start with SCROLLSPACK")
    }
    var at = Int64(PackFormat.magic.count)
    func block(_ what: String) throws -> Data {
      var len = [UInt8](repeating: 0, count: 8)
      _ = try pread(fd, &len, 8, at)
      let n = len.withUnsafeBytes { UInt64(littleEndian: $0.loadUnaligned(as: UInt64.self)) }
      guard n <= UInt64(PackFormat.maxHeadBytes), Int64(n) <= fileSize - at - 8 else {
        throw PackError.invalid("the \(what) length (\(n) bytes) is impossible")
      }
      var bytes = [UInt8](repeating: 0, count: Int(n))
      _ = try pread(fd, &bytes, Int(n), at + 8)
      at += 8 + Int64(n)
      return Data(bytes)
    }
    let manifestData = try block("manifest")
    let indexData = try block("index")
    let dataStart = at
    let manifest: PackManifest
    let index: JSONValue
    do {
      manifest = try PackManifest(json: try JSONValue.parse(manifestData))
      index = try JSONValue.parse(indexData)
    } catch let e as JSONParseError {
      throw PackError.invalid("its head is not JSON (\(e.message))")
    }
    guard index["format"]?.stringValue == PackFormat.name, index["codec"]?.stringValue == PackFormat.codec,
          index["frame_size"]?.safeInteger == PackFormat.frameSize, let list = index["members"]?.arrayValue
    else { throw PackError.invalid("its index is not SPK1 (format, codec or frame size)") }
    var entries: [String: Entry] = [:]
    var order: [String] = []
    for m in list {
      guard let path = m["path"]?.stringValue, let size = m["size"]?.safeInteger, let sha = m["sha256"]?.stringValue,
            let offset = m["offset"]?.safeInteger, let frames = m["frames"]?.arrayValue
      else { throw PackError.invalid("an index entry lacks path, size, sha256, offset or frames") }
      guard manifest.member(path) == PackMemberInfo(path: path, size: Int64(size), sha256: sha) else {
        throw PackError.invalid("member '\(path)' differs between the manifest and the index")
      }
      let expected = size == 0 ? 0 : (size + PackFormat.frameSize - 1) / PackFormat.frameSize
      guard frames.count == expected else { throw PackError.invalid("member '\(path)' has \(frames.count) frames, not \(expected)") }
      var pos = dataStart + Int64(offset)
      var table: [(offset: Int64, stored: Int)] = []
      table.reserveCapacity(frames.count)
      for f in frames {
        guard let stored = f.safeInteger, stored > 0, stored <= PackFormat.frameSize else {
          throw PackError.invalid("member '\(path)' has a frame of impossible length")
        }
        table.append((pos, stored))
        pos += Int64(stored)
      }
      guard pos <= fileSize else { throw PackError.invalid("member '\(path)' runs past the end of the file") }
      entries[path] = Entry(info: PackMemberInfo(path: path, size: Int64(size), sha256: sha), frames: table)
      order.append(path)
    }
    guard entries.count == manifest.members.count else { throw PackError.invalid("the index and the manifest list different members") }
    return (manifest, entries, order)
  }
}
