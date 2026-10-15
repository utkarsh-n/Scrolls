// OWNER: N0
// The write-ahead journal file (IOS-SPEC §6.2): `Notebook/journal-NNNNNN.jsonl`, one canonical-JSON line per user act,
// `{seq, at, actor, op, crc32}`, where the CRC-32 covers the canonical JSON of `{seq, at, actor, op}`. An append is
// written and made durable (F_FULLFSYNC, falling back to fsync) before it returns, so the atlas transaction that
// applies the op always follows its journal line. Files rotate at 32 MB. On open, a torn last line — no newline, or a
// CRC that does not match — is truncated away; a bad line anywhere else is corruption and is reported, never dropped.

import Foundation
import ScrollsContracts
import ScrollsCore

/// One journal line.
public struct JournalEntry: Codable, Sendable, Equatable {
  public let seq: UInt64
  public let at: String
  public let actor: String
  public let op: JournalOp
  public let crc32: UInt32

  /// Builds an entry and its CRC.
  public init(seq: UInt64, at: String, actor: String, op: JournalOp) throws {
    self.seq = seq
    self.at = at
    self.actor = actor
    self.op = op
    self.crc32 = CRC32.checksum(Array(CanonicalJSON.string(try JournalEntry.body(seq: seq, at: at, actor: actor, op: op)).utf8))
  }

  init(seq: UInt64, at: String, actor: String, op: JournalOp, crc32: UInt32) {
    self.seq = seq
    self.at = at
    self.actor = actor
    self.op = op
    self.crc32 = crc32
  }

  /// `{seq, at, actor, op}` as JSON (the op in the contract's JSON shape).
  static func body(seq: UInt64, at: String, actor: String, op: JournalOp) throws -> JSONValue {
    let opJSON = try JSONValue.parse(try ScrollsJSON.encoder.encode(op))
    return .object(["seq": .number(Double(seq)), "at": .string(at), "actor": .string(actor), "op": opJSON])
  }

  /// The line as written: canonical JSON of `{seq, at, actor, op, crc32}` and a newline.
  public func line() throws -> String {
    guard case .object(var o) = try JournalEntry.body(seq: seq, at: at, actor: actor, op: op) else { return "" }
    o["crc32"] = .number(Double(crc32))
    return CanonicalJSON.string(.object(o)) + "\n"
  }

  /// Parses one line (without its newline) and checks its CRC.
  public static func parse(line: String) throws -> JournalEntry {
    let v: JSONValue
    do { v = try JSONValue.parse(line) } catch { throw JournalError.unreadable("not JSON: \(error)") }
    guard case .object(var o) = v, let seqN = o["seq"]?.numberValue, let at = o["at"]?.stringValue,
      let actor = o["actor"]?.stringValue, let op = o["op"], let crcN = o["crc32"]?.numberValue,
      seqN >= 1, seqN == seqN.rounded(), crcN >= 0, crcN <= Double(UInt32.max)
    else { throw JournalError.unreadable("a line lacks seq, at, actor, op or crc32") }
    o["crc32"] = nil
    let crc = UInt32(crcN)
    guard CRC32.checksum(Array(CanonicalJSON.string(.object(o)).utf8)) == crc else {
      throw JournalError.checksum(seq: UInt64(seqN))
    }
    let decoded: JournalOp
    do {
      decoded = try ScrollsJSON.decoder.decode(JournalOp.self, from: Data(CanonicalJSON.string(op).utf8))
    } catch {
      throw JournalError.unreadable("seq \(UInt64(seqN)): the op does not decode: \(error)")
    }
    return JournalEntry(seq: UInt64(seqN), at: at, actor: actor, op: decoded, crc32: crc)
  }
}

/// Why a journal could not be read.
public enum JournalError: Error, Sendable, Equatable, CustomStringConvertible {
  case unreadable(String)
  case checksum(seq: UInt64)
  /// A bad line that is not the last one: the file was damaged, not torn by a crash.
  case corrupt(file: String, line: Int, reason: String)
  case outOfOrder(expected: UInt64, found: UInt64)

  public var description: String {
    switch self {
    case .unreadable(let s): "journal line unreadable: \(s)"
    case .checksum(let seq): "journal line \(seq) fails its CRC-32"
    case .corrupt(let f, let l, let r): "journal \(f) line \(l) is damaged (\(r)); nothing after it was applied"
    case .outOfOrder(let e, let f): "journal sequence jumps: expected \(e), found \(f)"
    }
  }
}

/// The journal of one notebook directory.
public actor JournalFile {
  /// A new file is started when the current one would grow past this.
  public static let rotateBytes = 32 << 20

  public nonisolated let directory: URL
  private let rotateLimit: Int
  private var handle: FileHandle
  private var fileIndex: Int
  private var fileBytes: Int
  /// The last sequence number written (0 for an empty journal).
  public private(set) var head: UInt64
  /// Bytes truncated from a torn last line when the journal was opened (0 normally).
  public nonisolated let truncatedBytes: Int

  /// Opens the newest `journal-NNNNNN.jsonl` in `directory` (creating the directory and the first file when needed)
  /// and truncates a torn last line. `rotateBytes` is for tests; the journal rotates at 32 MB.
  public init(directory: URL, rotateBytes: Int = JournalFile.rotateBytes) throws {
    self.directory = directory
    self.rotateLimit = rotateBytes
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let files = try JournalFile.files(in: directory)
    var index = files.last?.index ?? 1
    var head: UInt64 = 0
    var truncated = 0
    if let newest = files.last {
      let scan = try JournalFile.scan(newest.url, tolerateTornTail: true)
      if scan.validBytes < scan.totalBytes {
        let h = try FileHandle(forUpdating: newest.url)
        try h.truncate(atOffset: UInt64(scan.validBytes))
        try JournalFile.sync(h)
        try h.close()
        truncated = scan.totalBytes - scan.validBytes
      }
      head = scan.entries.last?.seq ?? 0
      if head == 0, files.count > 1 {
        head = try JournalFile.scan(files[files.count - 2].url, tolerateTornTail: false).entries.last?.seq ?? 0
      }
    } else {
      index = 1
    }
    let url = JournalFile.url(directory, index)
    if !FileManager.default.fileExists(atPath: url.path) {
      guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
        throw JournalError.unreadable("cannot create \(url.lastPathComponent)")
      }
      JournalFile.syncDirectory(directory)
    }
    let h = try FileHandle(forWritingTo: url)
    fileBytes = Int(try h.seekToEnd())
    handle = h
    fileIndex = index
    self.head = head
    truncatedBytes = truncated
  }

  deinit { try? handle.close() }

  /// Appends `op` as the next line and makes it durable before returning (write-ahead, §6.2 step 1).
  public func append(_ op: JournalOp, actor: String) throws -> JournalEntry {
    let entry = try JournalEntry(seq: head + 1, at: StoreClock.isoNow(), actor: actor, op: op)
    let bytes = Data(try entry.line().utf8)
    if fileBytes > 0, fileBytes + bytes.count > rotateLimit { try rotate() }
    do {
      try handle.write(contentsOf: bytes)
      try JournalFile.sync(handle)
    } catch {
      // never leave a partial line under the next append
      try? handle.truncate(atOffset: UInt64(fileBytes))
      try? JournalFile.sync(handle)
      throw error
    }
    fileBytes += bytes.count
    head = entry.seq
    return entry
  }

  /// Every entry with `seq > after`, in order, across all files. Damage ends the stream with an error after the last
  /// good entry before it (replay stops there, §6.5); a torn last line of the newest file is simply not yet written.
  public nonisolated func entries(after seq: UInt64) -> AsyncThrowingStream<JournalEntry, any Error> {
    let directory = self.directory
    return AsyncThrowingStream { continuation in
      let task = Task.detached {
        do {
          var expected: UInt64? = nil
          for f in try JournalFile.files(in: directory) {
            let scan = try JournalFile.scan(f.url, tolerateTornTail: true, stopAtDamage: true)
            for e in scan.entries {
              if let x = expected, e.seq != x { throw JournalError.outOfOrder(expected: x, found: e.seq) }
              expected = e.seq + 1
              if e.seq > seq { continuation.yield(e) }
              try Task.checkCancellation()
            }
            if let damage = scan.damage { throw damage }
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  // ── files ──

  private func rotate() throws {
    try handle.close()
    fileIndex += 1
    let url = JournalFile.url(directory, fileIndex)
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
      throw JournalError.unreadable("cannot create \(url.lastPathComponent)")
    }
    JournalFile.syncDirectory(directory)
    handle = try FileHandle(forWritingTo: url)
    fileBytes = 0
  }

  static func url(_ dir: URL, _ index: Int) -> URL {
    dir.appendingPathComponent(String(format: "journal-%06d.jsonl", index))
  }

  static func files(in dir: URL) throws -> [(index: Int, url: URL)] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    return names.compactMap { name -> (Int, URL)? in
      guard name.hasPrefix("journal-"), name.hasSuffix(".jsonl"), name.utf8.count == 20,
        let n = Int(name.dropFirst(8).prefix(6))
      else { return nil }
      return (n, dir.appendingPathComponent(name))
    }.sorted { $0.0 < $1.0 }
  }

  struct Scan {
    var entries: [JournalEntry] = []
    var validBytes = 0
    var totalBytes = 0
    /// With `stopAtDamage`: the corruption that ended the scan (the entries before it are kept).
    var damage: JournalError?
  }

  /// Reads a file. With `tolerateTornTail`, an unterminated or failing *last* line ends the scan (it is torn); a bad
  /// line followed by more lines is corruption — thrown, or with `stopAtDamage` returned in `damage`.
  static func scan(_ url: URL, tolerateTornTail: Bool, stopAtDamage: Bool = false) throws -> Scan {
    let data = try Data(contentsOf: url)
    var scan = Scan(totalBytes: data.count)
    var start = 0
    var lineNo = 0
    let bytes = [UInt8](data)
    while start < bytes.count {
      lineNo += 1
      guard let nl = bytes[start...].firstIndex(of: 0x0A) else {
        if tolerateTornTail { return scan }
        let damage = JournalError.corrupt(file: url.lastPathComponent, line: lineNo, reason: "unterminated line")
        if stopAtDamage { scan.damage = damage; return scan }
        throw damage
      }
      let text = String(decoding: bytes[start..<nl], as: UTF8.self)
      do {
        scan.entries.append(try JournalEntry.parse(line: text))
      } catch {
        let isLast = nl + 1 >= bytes.count
        if tolerateTornTail && isLast { return scan }
        let damage = JournalError.corrupt(file: url.lastPathComponent, line: lineNo, reason: String(describing: error))
        if stopAtDamage { scan.damage = damage; return scan }
        throw damage
      }
      start = nl + 1
      scan.validBytes = start
    }
    return scan
  }

  /// Makes written bytes durable: F_FULLFSYNC (the drive's cache too), else fsync.
  static func sync(_ h: FileHandle) throws {
    let fd = h.fileDescriptor
    if fcntl(fd, F_FULLFSYNC) == -1, fsync(fd) == -1 {
      throw JournalError.unreadable("fsync failed (errno \(errno))")
    }
  }

  /// Makes a new file's directory entry durable.
  static func syncDirectory(_ dir: URL) {
    let fd = open(dir.path, O_RDONLY)
    guard fd >= 0 else { return }
    _ = fsync(fd)
    close(fd)
  }
}

/// CRC-32 (IEEE 802.3, zlib's `crc32`).
public enum CRC32 {
  private static let table: [UInt32] = (0..<256).map { i -> UInt32 in
    var c = UInt32(i)
    for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
    return c
  }

  public static func checksum(_ bytes: [UInt8]) -> UInt32 {
    var c: UInt32 = 0xFFFF_FFFF
    for b in bytes { c = table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
    return c ^ 0xFFFF_FFFF
  }
}
