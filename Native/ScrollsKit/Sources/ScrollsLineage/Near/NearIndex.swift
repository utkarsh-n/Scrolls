// OWNER: N5
// The stored near-quotation index of a reuse-index run (server/lineage/near.mjs `lookupNear`, SPEC §4.7), read by the
// targeted trace: derived/reuse/run-<id>/units.bin and lsh.bin, both little-endian u32:
//   units.bin  'SCRU', version 1, n, then passage[n], t0[n], t1[n] (token range inside the passage)
//   lsh.bin    'SCRL', version 1, bands, rows, perms, seed, maxBucket, count[bands], then per band keys[count] (ascending)
//              and units[count] — only keys shared by 2…maxBucket units.
// A lookup reads only what it needs: one binary search per band, then the matching units.

import Foundation

public enum NearIndex {
  static let magicUnits: UInt32 = 0x5552_4353  // 'SCRU'
  static let magicLSH: UInt32 = 0x4C52_4353  // 'SCRL'
  static let version: UInt32 = 1

  /// An indexed unit that shares a band key with the query.
  public struct Hit: Sendable, Equatable {
    public var unit: UInt32
    public var passage: UInt32
    public var t0: UInt32
    public var t1: UInt32
  }

  /// Reads u32 values at byte offsets of an open file.
  struct U32File {
    let h: FileHandle
    func read(_ offset: UInt64, _ count: Int) throws -> [UInt32] {
      try h.seek(toOffset: offset)
      guard let d = try h.read(upToCount: count * 4), d.count == count * 4 else { throw CocoaError(.fileReadCorruptFile) }
      return d.withUnsafeBytes { raw in (0..<count).map { UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: $0 * 4, as: UInt32.self)) } }
    }
    func one(_ offset: UInt64) throws -> UInt32 { try read(offset, 1)[0] }
  }

  /// `lookupNear(dir, unitIds, {max})`: the indexed units sharing at least one band key with a sentence's token ids,
  /// in the reference's order (bands in order, keys ascending within a band, first-seen units), at most `max`; nil when
  /// the index is missing or unreadable.
  public static func lookup(_ dir: URL, _ unitIds: [UInt32], max: Int = 200) -> [Hit]? {
    guard let fl = try? FileHandle(forReadingFrom: dir.appendingPathComponent("lsh.bin")) else { return nil }
    defer { try? fl.close() }
    guard let fu = try? FileHandle(forReadingFrom: dir.appendingPathComponent("units.bin")) else { return nil }
    defer { try? fu.close() }
    do {
      let L = U32File(h: fl), U = U32File(h: fu)
      let head = try L.read(0, 7)
      guard head[0] == magicLSH, head[1] == version else { return nil }
      let bands = Int(head[2])
      let counts = try L.read(28, bands)
      let keys = MinHash.lshBands(MinHash.signature(MinHash.shingles3(unitIds), perms: Int(head[4]), seed: head[5]),
                                  bands: bands, rows: Int(head[3]))
      var units: [UInt32] = []
      var seen = Set<UInt32>()
      var offset = UInt64(28 + bands * 4)
      var b = 0
      while b < bands && units.count < max {
        let c = Int(counts[b])
        var lo = 0, hi = c
        while lo < hi {
          let m = (lo + hi) >> 1
          if try L.one(offset + UInt64(m * 4)) < keys[b] { lo = m + 1 } else { hi = m }
        }
        var i = lo
        while i < c && units.count < max {
          if try L.one(offset + UInt64(i * 4)) != keys[b] { break }
          let u = try L.one(offset + UInt64((c + i) * 4))
          if seen.insert(u).inserted { units.append(u) }
          i += 1
        }
        offset += UInt64(c * 8)
        b += 1
      }
      let uh = try U.read(0, 3)
      guard uh[0] == magicUnits, uh[1] == version else { return nil }
      let n = UInt64(uh[2])
      return try units.map { u in
        Hit(unit: u, passage: try U.one(12 + UInt64(u) * 4), t0: try U.one(12 + (n + UInt64(u)) * 4),
            t1: try U.one(12 + (2 * n + UInt64(u)) * 4))
      }
    } catch {
      return nil
    }
  }
}
