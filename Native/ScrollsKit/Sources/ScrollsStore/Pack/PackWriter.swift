// OWNER: N2
// Writes a `.scrollspack` (IOS-SPEC §3.5, §8.4.4; Native/Docs/PACK-FORMAT.md): `scrolls-cli pack` (and Tools/packs.sh)
// on the Mac. Members are added in order and compressed into 1 MiB LZFSE frames into a side file; `finish()` writes
// the head (magic, the completed canonical-JSON manifest, the member index with its frame table), appends the frames
// and returns the sha256 of the whole file. The pack is written to `<url>.building` and renamed into place, so a
// half-written pack never carries the final name.
//
// SPK1, byte by byte (little-endian):
//   "SCROLLSPACK" 0x01                        12 bytes of magic (the trailing byte is the format version)
//   u64 manifest length · manifest            canonical JSON, UTF-8
//   u64 index length · index                  canonical JSON {codec, format, frame_size, members:[{path, size, sha256,
//                                             offset, frames:[stored bytes…]}]}; offsets are relative to the data start
//   data                                      every member's frames back to back; a frame whose stored length equals its
//                                             raw length is stored raw (LZFSE would not shrink it)

import Compression
import CryptoKit
import Foundation
import ScrollsContracts
import ScrollsCore

/// The constants of format SPK1.
public enum PackFormat {
  /// "SCROLLSPACK" followed by the format version byte 1.
  public static let magic: [UInt8] = Array("SCROLLSPACK".utf8) + [1]
  public static let name = "SPK1"
  /// Raw bytes per frame.
  public static let frameSize = 1 << 20
  public static let codec = "lzfse"
  /// The file extension (UTType com.utkarsh.scrolls.pack).
  public static let fileExtension = "scrollspack"
  /// Head fields are capped so a damaged length never allocates gigabytes.
  static let maxHeadBytes = 64 << 20
}

/// Builds one pack file.
public struct PackWriter {
  private let url: URL
  private let template: PackManifest
  private let dataURL: URL
  private var data: FileHandle?
  private var dataBytes: Int64 = 0
  private var members: [PackMemberInfo] = []
  private var index: [JSONValue] = []
  private var paths: Set<String> = []

  /// Starts a pack at `url` with `manifest` (its member list is completed by `add`).
  public init(url: URL, manifest: PackManifest) throws {
    self.url = url
    self.template = manifest
    self.dataURL = url.appendingPathExtension("frames")
    let fm = FileManager.default
    try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? fm.removeItem(at: dataURL)
    guard fm.createFile(atPath: dataURL.path, contents: nil) else {
      throw PackError.invalid("cannot create \(dataURL.path)")
    }
    data = try FileHandle(forWritingTo: dataURL)
  }

  /// Appends the file at `file` as `member`.
  public mutating func add(member: String, from file: URL) throws {
    let input = try FileHandle(forReadingFrom: file)
    defer { try? input.close() }
    try add(member: member) { try input.read(upToCount: PackFormat.frameSize) }
  }

  /// Appends `bytes` as `member` (a member the pack command writes itself, such as a pack's FORMAT.md).
  public mutating func add(member: String, data bytes: Data) throws {
    var offset = 0
    try add(member: member) {
      guard offset < bytes.count else { return nil }
      let end = min(bytes.count, offset + PackFormat.frameSize)
      defer { offset = end }
      return bytes.subdata(in: offset..<end)
    }
  }

  private mutating func add(member path: String, next: () throws -> Data?) throws {
    guard !path.isEmpty, !path.hasPrefix("/"), !path.split(separator: "/").contains("..") else {
      throw PackError.invalid("member path '\(path)' must be relative and stay inside the pack")
    }
    guard !paths.contains(path) else { throw PackError.invalid("member '\(path)' was added twice") }
    guard let out = data else { throw PackError.invalid("the pack is already finished") }
    var hasher = SHA256()
    var size: Int64 = 0
    var frames: [JSONValue] = []
    let start = dataBytes
    // read exactly frameSize bytes per frame (FileHandle may return less before EOF)
    var pending = Data()
    func emit(_ raw: Data) throws {
      let stored = PackWriter.compress(raw)
      try out.write(contentsOf: stored)
      frames.append(.number(Double(stored.count)))
      dataBytes += Int64(stored.count)
    }
    while let chunk = try next(), !chunk.isEmpty {
      hasher.update(data: chunk)
      size += Int64(chunk.count)
      pending.append(chunk)
      while pending.count >= PackFormat.frameSize {
        try emit(pending.prefix(PackFormat.frameSize))
        pending = Data(pending.dropFirst(PackFormat.frameSize))
      }
    }
    if !pending.isEmpty { try emit(pending) }
    let sha = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    members.append(PackMemberInfo(path: path, size: size, sha256: sha))
    index.append(.object(["path": .string(path), "size": .number(Double(size)), "sha256": .string(sha),
                          "offset": .number(Double(start)), "frames": .array(frames)]))
    paths.insert(path)
  }

  /// Writes the member index and the manifest; returns the sha256 of the whole file.
  public mutating func finish() throws -> String {
    guard let out = data else { throw PackError.invalid("the pack is already finished") }
    try out.close()
    data = nil
    let manifest = template.with(members: members)
    let manifestBytes = Data(manifest.canonicalJSON.utf8)
    let indexValue: JSONValue = .object([
      "format": .string(PackFormat.name), "codec": .string(PackFormat.codec),
      "frame_size": .number(Double(PackFormat.frameSize)), "members": .array(index),
    ])
    let indexBytes = Data(CanonicalJSON.string(indexValue).utf8)
    let building = url.appendingPathExtension("building")
    let fm = FileManager.default
    try? fm.removeItem(at: building)
    guard fm.createFile(atPath: building.path, contents: nil) else {
      throw PackError.invalid("cannot create \(building.path)")
    }
    let file = try FileHandle(forWritingTo: building)
    var hasher = SHA256()
    func write(_ d: Data) throws {
      try file.write(contentsOf: d)
      hasher.update(data: d)
    }
    do {
      try write(Data(PackFormat.magic))
      try write(PackWriter.u64(UInt64(manifestBytes.count)))
      try write(manifestBytes)
      try write(PackWriter.u64(UInt64(indexBytes.count)))
      try write(indexBytes)
      let frames = try FileHandle(forReadingFrom: dataURL)
      defer { try? frames.close() }
      while let chunk = try frames.read(upToCount: 4 << 20), !chunk.isEmpty { try write(chunk) }
      try file.synchronize()
      try file.close()
    } catch {
      try? file.close()
      try? fm.removeItem(at: building)
      throw error
    }
    try? fm.removeItem(at: dataURL)
    try? fm.removeItem(at: url)
    try fm.moveItem(at: building, to: url)
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /// LZFSE when it shrinks the frame, otherwise the raw bytes.
  static func compress(_ raw: Data) -> Data {
    guard !raw.isEmpty else { return raw }
    var dst = [UInt8](repeating: 0, count: raw.count)
    let n = raw.withUnsafeBytes { src -> Int in
      dst.withUnsafeMutableBufferPointer { d in
        compression_encode_buffer(d.baseAddress!, d.count, src.bindMemory(to: UInt8.self).baseAddress!, src.count, nil,
                                  COMPRESSION_LZFSE)
      }
    }
    return n > 0 && n < raw.count ? Data(dst[0..<n]) : raw
  }

  static func u64(_ v: UInt64) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
}
