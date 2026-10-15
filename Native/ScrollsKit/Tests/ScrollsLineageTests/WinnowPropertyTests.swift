// OWNER: N5
// Properties of winnowing and MinHash (port of tests/lineage.winnow.test.mjs, SPEC §4.7): the 13-token guarantee at any
// position, density ≈ 2 / (w + 1), the short-sequence rules, and a stable in-place radix sort.

import Foundation
import ScrollsCore
@testable import ScrollsLineage
import Testing

@Suite("Winnowing properties")
struct WinnowPropertyTests {
  func randomIds(_ rnd: inout Mulberry32, _ n: Int, vocab: Double = 50_000) -> [UInt32] {
    (0..<n).map { _ in IDs.fnv1a32("w\(Int((rnd.next() * vocab).rounded(.down)))") }
  }

  @Test("k = 8, w = 6 and shingles hash with FNV-1a-32 over the ids' little-endian bytes")
  func constants() {
    #expect(Winnow.k == 8 && Winnow.w == 6)
    var rnd = Mulberry32(seed: 1)
    let ids = randomIds(&rnd, 40)
    let h = Winnow.shingleHashes(ids)
    #expect(h.count == 33)
    ids.withUnsafeBufferPointer { b in
      for i in 0..<h.count { #expect(h[i] == IDs.fnv1a32(u32: b, i..<(i + 8))) }
    }
    #expect(Winnow.tokenIds(["carry", "the", "zero"]) == ["carry", "the", "zero"].map { IDs.fnv1a32($0) })
  }

  @Test("every inserted run of 13 tokens is found (the winnowing guarantee), at any position")
  func guarantee() {
    var rnd = Mulberry32(seed: 1994)
    for trial in 0..<300 {
      let run = randomIds(&rnd, 13)
      var a = randomIds(&rnd, 50 + Int((rnd.next() * 400).rounded(.down)))
      var b = randomIds(&rnd, 50 + Int((rnd.next() * 400).rounded(.down)))
      let ia = Int((rnd.next() * Double(a.count - 13)).rounded(.down))
      let ib = Int((rnd.next() * Double(b.count - 13)).rounded(.down))
      a.replaceSubrange(ia..<(ia + 13), with: run)
      b.replaceSubrange(ib..<(ib + 13), with: run)
      let fa = Winnow.winnow(a), fb = Winnow.winnow(b)
      func inRun(_ f: Winnow.Fingerprints, _ at: Int) -> Set<UInt32> {
        Set((0..<f.count).filter { Int(f.positions[$0]) >= at && Int(f.positions[$0]) + 8 <= at + 13 }.map { f.hashes[$0] })
      }
      #expect(!inRun(fa, ia).isDisjoint(with: inRun(fb, ib)), "trial \(trial): the shared 13-token run has a common fingerprint")
    }
  }

  @Test("density is about 2 / (w + 1) fingerprints per token; positions rise; hashes are their shingles'")
  func density() {
    var rnd = Mulberry32(seed: 7)
    let ids = randomIds(&rnd, 200_000, vocab: 1e6)
    let f = Winnow.winnow(ids)
    let density = Double(f.count) / Double(ids.count)
    #expect(abs(density - 2.0 / 7.0) < 0.02, "density \(density)")
    for i in 1..<f.count where f.positions[i] <= f.positions[i - 1] { Issue.record("positions do not increase at \(i)") }
    ids.withUnsafeBufferPointer { b in
      for i in stride(from: 0, to: f.count, by: 97) {
        let p = Int(f.positions[i])
        #expect(f.hashes[i] == IDs.fnv1a32(u32: b, p..<(p + 8)))
      }
    }
  }

  @Test("short sequences: < k tokens give nothing; k … k + w − 2 tokens give their minimum")
  func shortSequences() {
    var rnd = Mulberry32(seed: 3)
    #expect(Winnow.winnow(randomIds(&rnd, 7)).count == 0)
    let ids = randomIds(&rnd, 10)
    let f = Winnow.winnow(ids)
    #expect(f.count == 1)
    #expect(f.hashes.first == Winnow.shingleHashes(ids).min())
    #expect(Winnow.winnow(ids) == Winnow.winnow(Array(ids)), "deterministic")
  }

  @Test("radixSortPairs sorts by key, stable for equal keys, in place")
  func radix() {
    var rnd = Mulberry32(seed: 11)
    let n = 50_000
    var keys = (0..<n).map { _ in UInt32(truncatingIfNeeded: Int64((rnd.next() * 3000).rounded(.down)) * 1_000_003) }
    var vals = (0..<n).map { UInt32($0) }
    let expected = zip(keys, vals).sorted { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
    Winnow.radixSortPairs(&keys, &vals)
    #expect(keys == expected.map(\.0))
    #expect(vals == expected.map(\.1), "equal keys keep their input order")
    var one: [UInt32] = [5], v: [UInt32] = [1]
    Winnow.radixSortPairs(&one, &v)
    #expect(one == [5])
    // a prefix sort leaves the tail alone
    var k3: [UInt32] = [3, 1, 2, 0], v3: [UInt32] = [0, 1, 2, 3]
    Winnow.radixSortPairs(&k3, &v3, count: 3)
    #expect(k3 == [1, 2, 3, 0] && v3 == [1, 2, 0, 3])
  }

  @Test("MinHash: band keys of a range equal the full signature's; identical sets collide in every band")
  func minhashBands() {
    var rnd = Mulberry32(seed: 5)
    let sh = MinHash.shingles3(randomIds(&rnd, 40))
    let full = MinHash.lshBands(MinHash.signature(sh))
    #expect(MinHash.bandKeysRange(sh, band0: 0, band1: MinHash.bands) == full)
    #expect(MinHash.bandKeysRange(sh, band0: 5, band1: 9) == Array(full[5..<9]))
    #expect(MinHash.jaccard(sh, sh) == 1)
    #expect(MinHash.jaccard([], []) == 0)
    #expect(MinHash.permutations().a.allSatisfy { $0 & 1 == 1 }, "a is odd")
  }
}
