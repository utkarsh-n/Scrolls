// OWNER: N5
// The pure half of server/lineage/boilerplate.mjs (SPEC §4.7): the licence lexicon, the fingerprint record store, the
// per-slot tallies, fingerprinting one document, classifying the sorted fingerprint groups and deciding passages by
// rules A, B and C. Every step is the reference's, in its order, so the flagged passages and every metric are equal
// (G2 `g2.boilerplate`, exact). `BoilerplateDetector` (BoilerplatePass.swift) drives it inside a job.
//
// A record's ref is slot · 4 + edge · 2 + lexicon (slots < 2³⁰). A slot is one body passage of a document, or the
// document's "outside the body" slot (header and footer text, boilerplate by construction).

import Foundation
import ScrollsCore

/// The constants and kernels of the boilerplate pass.
public enum Boilerplate {
  /// Parameters of SPEC §4.7 and of the two edge-zone rules (`DEFAULTS`).
  public struct Parameters: Sendable, Equatable {
    public var k: Int
    public var w: Int
    /// Widespread: the hash occurs in MORE than this many distinct (non-duplicate) documents.
    public var minDocs: Int
    /// The first / last share of the body that is its edge.
    public var edge: Double
    /// A widespread group is boilerplate when at least this share of its occurrences lies at the edges.
    public var groupEdgeShare: Double
    /// Rule A: at least this share of a passage's fingerprints are in boilerplate groups.
    public var passageShare: Double
    /// Rule B: lexicon matches needed in an edge-zone passage.
    public var edgeLexicon: Int

    public init(k: Int = Winnow.k, w: Int = Winnow.w, minDocs: Int = 25, edge: Double = 0.15, groupEdgeShare: Double = 0.5,
                passageShare: Double = 0.5, edgeLexicon: Int = 2) {
      self.k = k
      self.w = w
      self.minDocs = minDocs
      self.edge = edge
      self.groupEdgeShare = groupEdgeShare
      self.passageShare = passageShare
      self.edgeLexicon = edgeLexicon
    }

    public static let defaults = Parameters()

    /// The run's `params_json` (and `metrics.params`), keyed as the reference.
    public var json: JSONValue {
      ["k": .number(Double(k)), "w": .number(Double(w)), "min_docs": .number(Double(minDocs)), "edge": .number(edge),
       "group_edge_share": .number(groupEdgeShare), "passage_share": .number(passageShare),
       "edge_lexicon": .number(Double(edgeLexicon))]
    }
  }

  /// The licence lexicon of §4.7 as folded-token patterns; a single-token term matches tokens that start with it.
  public static let licenceLexicon: [[String]] = [
    ["project", "gutenberg"], ["ebook"], ["license"], ["licence"], ["donation"], ["trademark"], ["small", "print"],
    ["computer", "virus"], ["computer", "codes"],
  ]

  /// The canary sentence (folded tokens) that must not survive in an ok passage.
  public static let canaryTokens = ["computer", "virus", "or", "computer", "codes", "that", "damage"]

  static let edgeBit: UInt32 = 2
  static let lexBit: UInt32 = 1

  /// The quality of a slot's passage as the pass sees it.
  public enum SlotQuality: UInt8, Sendable { case ok = 1, boilerplate = 2, other = 3 }

  // MARK: - the lexicon

  /// `lexiconStarts(tokens)`: the length of the lexicon term starting at each token (0 = none).
  public static func lexiconStarts(_ tokens: [String]) -> [UInt8] {
    let masks = tokens.map(lexiconMask)
    return lexiconStarts(masks: masks)
  }

  /// Per folded token: bit t = term t's first element matches it (a prefix for one-token terms, equality for pairs);
  /// bit 16 + t = a pair term's second element is a prefix of it.
  static func lexiconMask(_ token: String) -> UInt32 {
    var m: UInt32 = 0
    let u = Array(token.utf16)
    for (t, term) in licenceLexicon.enumerated() {
      if term.count == 1 {
        if u.starts(with: term[0].utf16) { m |= 1 << UInt32(t) }
      } else {
        if u.elementsEqual(term[0].utf16) { m |= 1 << UInt32(t) }
        if u.starts(with: term[1].utf16) { m |= 1 << UInt32(16 + t) }
      }
    }
    return m
  }

  /// The reference's term loop over precomputed masks: the first term that matches at a token wins.
  static func lexiconStarts(masks: [UInt32]) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: masks.count)
    for i in 0..<masks.count where masks[i] & 0xffff != 0 {
      for (t, term) in licenceLexicon.enumerated() {
        guard masks[i] & (1 << UInt32(t)) != 0 else { continue }
        if term.count == 1 {
          out[i] = 1
          break
        } else if i + 1 < masks.count && masks[i + 1] & (1 << UInt32(16 + t)) != 0 {
          out[i] = 2
          break
        }
      }
    }
    return out
  }

  // MARK: - one document's tokens

  /// The tokens of one original: their UTF-16 starts, FNV ids and lexicon starts.
  public struct DocumentTokens: Sendable {
    public var starts: [Int32]
    public var ids: [UInt32]
    public var lex: [UInt8]
    public var count: Int { starts.count }
  }

  /// Tokenizes with an interner so each distinct form is folded and hashed once; the caches are bounded (dropped past
  /// `maxForms` distinct forms) so a corpus of many scripts never holds every form at once.
  public final class Tokenizing {
    private var interner = TokenInterner()
    private var hashByID: [UInt32] = []
    private var maskByID: [UInt32] = []
    private var spans: [TokenSpan] = []
    let maxForms: Int

    public init(maxForms: Int = 200_000) { self.maxForms = maxForms }

    /// `tokenize(original)` → starts, ids and lexicon starts.
    public func tokens(_ units: UnsafeBufferPointer<UInt16>) -> DocumentTokens {
      if interner.count > maxForms {
        interner = TokenInterner()
        hashByID.removeAll(keepingCapacity: true)
        maskByID.removeAll(keepingCapacity: true)
      }
      spans.removeAll(keepingCapacity: true)
      Tokenizer.spans(units, interner: interner, into: &spans)
      while hashByID.count < interner.count {
        let norm = interner.norm(TokenID(rawValue: UInt32(hashByID.count)))
        hashByID.append(IDs.fnv1a32(norm))
        maskByID.append(Boilerplate.lexiconMask(norm))
      }
      let n = spans.count
      var starts = [Int32](repeating: 0, count: n)
      var ids = [UInt32](repeating: 0, count: n)
      var masks = [UInt32](repeating: 0, count: n)
      for i in 0..<n {
        let s = spans[i]
        starts[i] = s.start
        ids[i] = hashByID[Int(s.norm.rawValue)]
        masks[i] = maskByID[Int(s.norm.rawValue)]
      }
      return DocumentTokens(starts: starts, ids: ids, lex: Boilerplate.lexiconStarts(masks: masks))
    }

    public func tokens(_ text: String) -> DocumentTokens {
      let u = Array(text.utf16)
      return u.withUnsafeBufferPointer { tokens($0) }
    }
  }

  // MARK: - records and slots

  /// Growable (hash, ref) record store (`Records`).
  public struct Records: Sendable {
    public var hashes: [UInt32] = []
    public var refs: [UInt32] = []
    public init(capacity: Int = 1024) {
      hashes.reserveCapacity(max(1024, capacity))
      refs.reserveCapacity(max(1024, capacity))
    }
    public var count: Int { hashes.count }
    @inline(__always)
    public mutating func push(_ hash: UInt32, _ ref: UInt32) {
      hashes.append(hash)
      refs.append(ref)
    }
  }

  /// Per-slot tallies of a pass (`SlotTable`), grown one slot at a time (passage slots of a document are consecutive,
  /// in body order, followed by the document's outside slot).
  public struct SlotTable: Sendable {
    /// Passage id; -1 = a document's outside-body slot.
    public var passage: [Int64] = []
    /// Document index (into the pass's document list).
    public var doc: [Int32] = []
    public var quality: [UInt8] = []
    public var fp: [UInt32] = []
    public var lex: [UInt16] = []
    public var edgeZone: [UInt8] = []
    public var bp: [UInt32] = []
    public var cp: [UInt32] = []
    /// The most widely shared commonplace group of the slot, and its document count.
    public var cpKey: [UInt32] = []
    public var cpDocs: [UInt32] = []

    public init(capacity: Int = 0) {
      passage.reserveCapacity(capacity)
      doc.reserveCapacity(capacity)
      quality.reserveCapacity(capacity)
      fp.reserveCapacity(capacity)
      lex.reserveCapacity(capacity)
      edgeZone.reserveCapacity(capacity)
      bp.reserveCapacity(capacity)
      cp.reserveCapacity(capacity)
      cpKey.reserveCapacity(capacity)
      cpDocs.reserveCapacity(capacity)
    }

    public var used: Int { passage.count }

    /// Adds a slot and returns its index.
    public mutating func add(passage id: Int64, doc: Int, quality: SlotQuality) -> Int {
      passage.append(id)
      self.doc.append(Int32(doc))
      self.quality.append(quality.rawValue)
      fp.append(0)
      lex.append(0)
      edgeZone.append(0)
      bp.append(0)
      cp.append(0)
      cpKey.append(0)
      cpDocs.append(0)
      return passage.count - 1
    }
  }

  /// A body passage of the document being fingerprinted, with its preassigned slot.
  public struct PassageSlot: Sendable, Equatable {
    public var start: Int32
    public var end: Int32
    public var slot: Int
    public init(start: Int32, end: Int32, slot: Int) {
      self.start = start
      self.end = end
      self.slot = slot
    }
  }

  /// First index whose value is ≥ x.
  @inline(__always)
  static func lowerBound(_ a: [Int32], _ x: Int32) -> Int {
    var lo = 0, hi = a.count
    while lo < hi {
      let mid = (lo + hi) >> 1
      if a[mid] < x { lo = mid + 1 } else { hi = mid }
    }
    return lo
  }

  /// `fingerprintDocument`: winnows one document's whole original (body and the text outside it) into `records`
  /// and fills its slots' tallies. `passages` are sorted by start. Returns the tokens in the document.
  @discardableResult
  public static func fingerprintDocument(_ tok: DocumentTokens, bodyStart: Int32, bodyEnd: Int32, passages: [PassageSlot],
                                         outsideSlot: Int, parameters p: Parameters, records: inout Records,
                                         slots: inout SlotTable) -> Int {
    let n = tok.count
    if n == 0 { return 0 }
    let starts = tok.starts, lex = tok.lex
    let b0 = lowerBound(starts, bodyStart)
    let b1 = max(b0, lowerBound(starts, bodyEnd))
    let bodyLen = Double(max(1, b1 - b0))
    let edge = p.edge
    @inline(__always) func inEdge(_ i: Int) -> Bool {
      i < b0 || i >= b1 || Double(i - b0) / bodyLen < edge || Double(i - b0) / bodyLen >= 1 - edge
    }

    for ps in passages {
      let t0 = lowerBound(starts, ps.start), t1 = lowerBound(starts, ps.end)
      var m = 0
      if t0 < t1 { for i in t0..<t1 where lex[i] != 0 { m += 1 } }
      slots.lex[ps.slot] = UInt16(min(65_535, m))
      slots.edgeZone[ps.slot] = t0 < t1 && inEdge(t0) ? 1 : 0
    }

    let f = tok.ids.withUnsafeBufferPointer { Winnow.winnow($0, k: p.k, w: p.w) }
    var pi = 0
    let k = p.k
    for x in 0..<f.count {
      let pos = Int(f.positions[x])
      var slot = outsideSlot
      if pos >= b0 && pos < b1 {
        let off = starts[pos]
        while pi < passages.count && passages[pi].end <= off { pi += 1 }
        if pi < passages.count && passages[pi].start <= off { slot = passages[pi].slot }
      }
      var isLex: UInt32 = 0
      let e = min(n, pos + k)
      var j = pos
      while j < e {
        if lex[j] != 0 && j + Int(lex[j]) <= e {
          isLex = 1
          break
        }
        j += 1
      }
      records.push(f.hashes[x], UInt32(slot) << 2 + (inEdge(pos) ? edgeBit : 0) + isLex)
      slots.fp[slot] += 1
    }
    return n
  }

  /// What `classifyGroups` counted.
  public struct GroupStats: Sendable, Equatable {
    public var groups = 0
    public var widespread = 0
    public var boilerplate = 0
    public var commonplace = 0
    public init() {}
  }

  /// `classifyGroups`: walks the hash-sorted records group by group; a group in more than `minDocs` countable
  /// documents is widespread, and adds each of its occurrences to `slots.bp` (boilerplate) or `slots.cp`
  /// (commonplace, remembering the slot's most widely shared commonplace group).
  public static func classifyGroups(_ records: Records, slots: inout SlotTable, countable: [Bool], parameters p: Parameters)
    -> GroupStats
  {
    var stats = GroupStats()
    let n = records.count
    records.hashes.withUnsafeBufferPointer { hashes in
      records.refs.withUnsafeBufferPointer { refs in
        var i = 0
        while i < n {
          let h = hashes[i]
          var j = i, occ = 0, edges = 0, lexes = 0, docs = 0
          var lastDoc: Int32 = -1
          while j < n && hashes[j] == h {
            let ref = refs[j]
            let d = slots.doc[Int(ref >> 2)]
            if countable[Int(d)] {
              occ += 1
              if ref & edgeBit != 0 { edges += 1 }
              if ref & lexBit != 0 { lexes += 1 }
              if d != lastDoc {
                docs += 1
                lastDoc = d
              }
            }
            j += 1
          }
          stats.groups += 1
          if docs > p.minDocs {
            stats.widespread += 1
            let boiler = Double(edges) >= p.groupEdgeShare * Double(occ) || lexes * 2 > occ
            if boiler { stats.boilerplate += 1 } else { stats.commonplace += 1 }
            for r in i..<j {
              let slot = Int(refs[r] >> 2)
              if boiler {
                slots.bp[slot] += 1
              } else {
                slots.cp[slot] += 1
                if UInt32(docs) > slots.cpDocs[slot] {
                  slots.cpDocs[slot] = UInt32(docs)
                  slots.cpKey[slot] = h
                }
              }
            }
          }
          i = j
        }
      }
    }
    return stats
  }

  /// Passages flagged per rule (`flagged_by_rule`).
  public struct RuleCounts: Sendable, Equatable {
    public var sharedText = 0
    public var licenceWordingAtEdge = 0
    public var licenceBlock = 0
    public init() {}
    public var json: JSONValue {
      ["shared_text": .number(Double(sharedText)), "licence_wording_at_edge": .number(Double(licenceWordingAtEdge)),
       "licence_block": .number(Double(licenceBlock))]
    }
  }

  /// `decidePassages`: rules A (shared text) and B (licence wording at the edge), then rule C (inside a licence
  /// block) until nothing changes. Returns the flagged slots in the reference's order.
  public static func decidePassages(_ slots: SlotTable, parameters p: Parameters) -> (flagged: [Int], byRule: RuleCounts) {
    let used = slots.used
    var flagged: [Int] = []
    var byRule = RuleCounts()
    var isBp = [Bool](repeating: false, count: used)
    let ok = SlotQuality.ok.rawValue, bpQ = SlotQuality.boilerplate.rawValue
    for s in 0..<used {
      if slots.passage[s] < 0 { continue }
      if slots.quality[s] == bpQ {
        isBp[s] = true
        continue
      }
      if slots.quality[s] != ok { continue }
      if slots.fp[s] > 0 && Double(slots.bp[s]) >= p.passageShare * Double(slots.fp[s]) {
        isBp[s] = true
        flagged.append(s)
        byRule.sharedText += 1
      } else if slots.edgeZone[s] != 0 && Int(slots.lex[s]) >= p.edgeLexicon && slots.bp[s] >= 1 {
        isBp[s] = true
        flagged.append(s)
        byRule.licenceWordingAtEdge += 1
      }
    }
    // a neighbour that is another document's slot, or a document's outside slot, is the body edge
    func edgeOrBp(_ s: Int, _ t: Int) -> Bool {
      t < 0 || t >= used || slots.passage[t] < 0 || slots.doc[t] != slots.doc[s] || isBp[t]
    }
    var changed = true
    while changed {
      changed = false
      for s in 0..<used {
        if slots.passage[s] < 0 || isBp[s] || slots.quality[s] != ok || slots.edgeZone[s] == 0 { continue }
        if !(slots.lex[s] >= 1 || slots.bp[s] >= 1) { continue }
        if edgeOrBp(s, s - 1) && edgeOrBp(s, s + 1) {
          isBp[s] = true
          flagged.append(s)
          byRule.licenceBlock += 1
          changed = true
        }
      }
    }
    return (flagged, byRule)
  }

  /// 8 lowercase hex digits (`toString(16).padStart(8, '0')`), the key of a commonplace group.
  public static func hex8(_ h: UInt32) -> String {
    let s = String(h, radix: 16)
    return String(repeating: "0", count: max(0, 8 - s.count)) + s
  }
}
