// OWNER: N4
// Port of server/analysis/collocations.mjs (SPEC §4.6): window ±5 tokens clipped at passage boundaries; a candidate
// needs f(x,y) ≥ 5 and f(y) ≥ 10; significance is Dunning's G² ≥ 10.83 with Benjamini–Hochberg q < .05 over all
// candidates of the slice; strength is logDice = 14 + log₂(2·f_xy / (f_x + f_y)), PPMI (context smoothing α = 0.75) a
// secondary column; ranked by logDice. Per-language stop-words are hidden by default (and counted). Gate: the target
// needs n ≥ 20 in the slice, else "Too few occurrences (12; needs 20). Showing KWIC." Context words, not meanings.
// Counts come from the token streams when they are current; without them a slice of at most 2,000,000 tokens is
// tokenized on the fly; larger slices need the streams and say so instead of guessing.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// Collocations and the context counts behind them.
public enum Collocations {
  /// Pipeline version of collocation runs and payloads.
  public static let version = "collocations@1.0.0"
  /// Window on each side, in tokens (§4.4).
  public static let window = 5
  /// PPMI context smoothing.
  public static let ppmiAlpha = 0.75
  /// Largest slice (tokens) tokenized on the fly when no current token stream exists.
  public static let syncTokenLimit = 2_000_000
  /// The label every collocate list carries (§13 rule 11).
  public static let contextLabel = "context words, not meanings"

  /// Folded stop-words of the given languages (languages without a list add none).
  static func stopSet(_ langs: [String]) -> JSSet {
    var out = JSSet()
    for l in langs {
      let base = String(l.split(separator: "-", omittingEmptySubsequences: false).first ?? "")
      for w in Stopwords.lists[base] ?? [] { out.insert(w) }
    }
    return out
  }

  /// Window counts of a slice.
  struct Counts {
    var source: String
    var fx = 0
    var W = 0
    var N = 0
    var fxy = JSMap<Double>()
    var fy = JSMap<Double>()
    var sumFyAlpha = 0.0
    var langs: [String]
    var passages: Int
    var stop: JSSet
  }

  /// Why a slice's counts could not be taken.
  struct Unavailable {
    var langs: [String]
    var tokens: Int
    var limit: Int
    var status: [(lang: String, words: String)]
    var statusJSON: JSONValue { .object(JSONObject(status.map { ($0.lang, JSONValue.string($0.words)) })) }
  }

  struct Contexts {
    var counts: Counts?
    var unavailable: Unavailable?
  }

  struct Row {
    var term: String
    var fXY: Int
    var fY: Int
    var logDice: Double
    var ppmi: Double
    var g2: Double
    var q: Double
  }

  /// `collocates(ctx, opts)`: scored, filtered and ranked collocates.
  static func collocates(_ ctx: Counts, minFxy: Double = Double(Thresholds.Collocates.fXY), minFy: Double = Double(Thresholds.Collocates.fY),
                         g2Min: Double = Thresholds.Collocates.g2, qMax: Double = Thresholds.Collocates.q, showStop: Bool = false,
                         limit: Int = 100) -> (rows: [Row], candidates: Int, significant: Int, hiddenStopwords: Int) {
    let W = Double(ctx.W), N = Double(ctx.N), fx = Double(ctx.fx)
    struct Cand { var term: String, fxy: Double, fy: Double, g2: Double, p: Double, attract: Bool }
    var cands: [Cand] = []
    for (term, f) in ctx.fxy {
      let y = ctx.fy[term] ?? 0
      if f < minFxy || y < minFy { continue }
      let o11 = f, o12 = max(0, W - f), o21 = max(0, y - f), o22 = max(0, N - W - y + f)
      let g = Intervals.g2(o11, o12, o21, o22)
      cands.append(Cand(term: term, fxy: f, fy: y, g2: g, p: Intervals.chi2Sf(g, 1), attract: N > 0 && o11 > W * y / N))
    }
    let qs = Intervals.benjaminiHochberg(cands.map(\.p))
    var hidden = 0
    var rows: [Row] = []
    for (i, c) in cands.enumerated() {
      if !(c.attract && c.g2 >= g2Min && qs[i] < qMax) { continue }
      if !showStop && ctx.stop.contains(c.term) {
        hidden += 1
        continue
      }
      let pY = ctx.sumFyAlpha > 0 ? jsPow(c.fy, ppmiAlpha) / ctx.sumFyAlpha : 0
      let pmi = W > 0 && pY > 0 ? jsLog2((c.fxy / W) / pY) : 0
      rows.append(Row(term: c.term, fXY: Int(c.fxy), fY: Int(c.fy), logDice: JSRound.fixed(14 + jsLog2(2 * c.fxy / (fx + c.fy)), 2),
                      ppmi: JSRound.fixed(max(0, pmi), 2), g2: JSRound.fixed(c.g2, 2), q: JSRound.precision(qs[i], 3)))
    }
    let sorted = rows.jsSorted { x, y in
      let d = y.logDice - x.logDice
      if d != 0 { return d }
      let g = y.g2 - x.g2
      if g != 0 { return g }
      return jsLess(x.term, y.term) ? -1 : 1
    }
    return (Array(sorted.prefix(limit)), cands.count, sorted.count, hidden)
  }

  /// Variant id sequences by first id, longest first (`variantSeqs`).
  static func variantSeqs(_ scope: Scope, _ toId: (String) -> Int?) -> [Int: [[Int]]] {
    var byFirst: [Int: [[Int]]] = [:]
    var order: [Int] = []
    for e in scope.exprs {
      for v in e.variants {
        let ids = v.tokens.map(toId)
        if ids.isEmpty || ids.contains(where: { $0 == nil }) { continue }
        let seq = ids.map { $0! }
        if byFirst[seq[0]] == nil { order.append(seq[0]) }
        byFirst[seq[0], default: []].append(seq)
      }
    }
    for k in order { byFirst[k] = byFirst[k]!.stableSorted { $0.count > $1.count } }
    return byFirst
  }

  /// Token positions of name-guard hits by passage (excluded unless nm = 1).
  static func nameExclusions(_ c: Connection, _ scope: Scope, _ docIds: [Int], reader: inout PassageTextReader) throws -> [Int: Set<Int>] {
    var out: [Int: Set<Int>] = [:]
    if scope.toggles.nm == 1 { return out }
    let json = jsonArray(docIds)
    for e in scope.exprs {
      let rows = try c.rows(AnalysisSQL.nameOccurrences, [.int(Int64(e.id)), .int(Int64(e.run)), .text(json)]) { r in
        (pid: r.i(0), start: r.i(1), doc: r.i(2), field: r.text(3), pStart: r.i(4), pEnd: r.i(5))
      }
      for r in rows {
        guard let text = reader.read(document: r.doc, field: r.field, start: r.pStart, end: r.pEnd) else { continue }
        let starts = Tokenizer.tokens(text).starts
        guard let i = starts.firstIndex(of: Int32(r.start - r.pStart)) else { continue }
        out[r.pid, default: []].insert(i)
      }
    }
    return out
  }

  /// Context counts of the target in one slice (`sliceContexts`).
  static func sliceContexts(_ c: Connection, _ scope: Scope, _ spec: SliceSpec, _ stats: SliceStats, reader: inout PassageTextReader,
                            streams dir: URL?, window: Int = window, tokenLimit: Int = syncTokenLimit,
                            checkpoint: () throws -> Void = {}) throws -> Contexts {
    let docIds = stats.perDoc.map(\.id)
    let classes = Set(stats.classes)
    var early = JSSet()
    var earlyTokens = 0
    for id in docIds {
      guard let doc = scope.docIndex[id] else { continue }
      for t in doc.tok {
        if !classes.contains(t.fc) || !(stats.unit == "works" || spec.langOk(t.plang, t.fc, doc.langText)) { continue }
        early.insert(t.plang)
        earlyTokens += t.tokens
      }
    }
    if earlyTokens > tokenLimit {
      let st = try early.sorted.map { ($0, try TokenStreams.status(c, dir, $0)) }
      let stale = st.filter { !$0.1.fresh }.map(\.0)
      if !stale.isEmpty {
        return Contexts(counts: nil, unavailable: Unavailable(langs: stale, tokens: earlyTokens, limit: tokenLimit,
                                                              status: st.map { ($0.0, $0.1.words) }))
      }
    }
    let passages = try c.rows(AnalysisSQL.slicePassages, [.text(jsonArray(docIds))]) { r in
      (id: r.i(0), doc: r.i(1), field: r.text(2), fc: r.text(3), lang: r.text(4), start: r.i(5), end: r.i(6), tokens: r.i(7))
    }.filter { p in
      classes.contains(p.fc) && (stats.unit == "works" || spec.langOk(p.lang, p.fc, scope.docIndex[p.doc]?.langText))
    }
    let langs = JSSet(passages.map(\.lang)).sorted
    let tokens = passages.reduce(0) { $0 + $1.tokens }
    let status = try langs.map { ($0, try TokenStreams.status(c, dir, $0)) }
    let stale = status.filter { !$0.1.fresh }.map(\.0)
    let source: String
    if stale.isEmpty {
      source = "stream"
    } else if tokens <= tokenLimit {
      source = "tokenized"
    } else {
      return Contexts(counts: nil, unavailable: Unavailable(langs: stale, tokens: tokens, limit: tokenLimit,
                                                            status: status.map { ($0.0, $0.1.words) }))
    }
    let excluded = try nameExclusions(c, scope, docIds, reader: &reader)
    var out = Counts(source: source, langs: langs, passages: passages.count, stop: stopSet(langs))
    for lang in langs {
      let own = passages.filter { $0.lang == lang }
      var counts: [Int] = []
      var vocab: [String] = []
      var local: [JSKey: Int] = [:]
      let stream: TokenStreams.Stream? = source == "stream" ? try TokenStreams.open(dir!, lang) : nil
      if let stream {
        counts = [Int](repeating: 0, count: stream.vocab.count)
        vocab = stream.vocab
      }
      func toIdLocal(_ t: String) -> Int {
        let k = JSKey(t)
        if let id = local[k] { return id }
        let id = vocab.count
        local[k] = id
        vocab.append(t)
        counts.append(0)
        return id
      }
      // chunks: (items [(passage, stream range or nil)], start, end)
      struct Chunk { var items: [(pid: Int, range: (Int, Int)?)]; var start: Int; var end: Int; var passage: Int? }
      var chunks: [Chunk] = []
      if let stream {
        for p in own {
          guard let r = stream.range(p.id) else { continue }
          if var last = chunks.last, last.end == r.0 {
            last.end = r.1
            last.items.append((p.id, r))
            chunks[chunks.count - 1] = last
          } else {
            chunks.append(Chunk(items: [(p.id, r)], start: r.0, end: r.1, passage: nil))
          }
        }
      } else {
        chunks = own.enumerated().map { i, p in Chunk(items: [(p.id, nil)], start: 0, end: 0, passage: i) }
      }
      let seqs: [Int: [[Int]]]
      if let stream { seqs = variantSeqs(scope) { stream.idOf($0) } } else { seqs = variantSeqs(scope) { toIdLocal($0) } }
      // f(x, y) by stream id, in first-seen order (the reference's Map)
      var fxyOrder: [Int: Int] = [:]
      var fxyIds: [Int] = []
      var fxyCounts: [Int] = []
      for chunk in chunks {
        try checkpoint()
        let ids: [Int]
        if let stream {
          ids = try stream.readIds(chunk.start, chunk.end)
        } else {
          let p = own[chunk.passage!]
          if let text = reader.read(document: p.doc, field: p.field, start: p.start, end: p.end) {
            ids = Tokenizer.tokens(text).tokens.map { toIdLocal($0) }
          } else {
            ids = []
          }
        }
        for (pid, r) in chunk.items {
          let a = r.map { $0.0 - chunk.start } ?? 0, b = r.map { $0.1 - chunk.start } ?? ids.count
          let skip = excluded[pid]
          for i in a..<b { counts[ids[i]] += 1 }
          out.N += b - a
          var i = a
          while i < b {
            defer { i += 1 }
            guard let cands = seqs[ids[i]] else { continue }
            var len = 0
            for s in cands {
              if i + s.count > b { continue }
              var ok = true
              for j in 1..<max(1, s.count) where ids[i + j] != s[j] {
                ok = false
                break
              }
              if ok {
                len = s.count
                break
              }
            }
            if len == 0 || (skip?.contains(i - a) ?? false) { continue }
            out.fx += 1
            func bump(_ id: Int) {
              if let k = fxyOrder[id] { fxyCounts[k] += 1 } else {
                fxyOrder[id] = fxyIds.count
                fxyIds.append(id)
                fxyCounts.append(1)
              }
              out.W += 1
            }
            for j in max(a, i - window)..<i { bump(ids[j]) }
            let hiEnd = min(b, i + len + window)
            if i + len < hiEnd { for j in (i + len)..<hiEnd { bump(ids[j]) } }
          }
        }
      }
      for id in 0..<counts.count where counts[id] != 0 { out.sumFyAlpha += jsPow(Double(counts[id]), ppmiAlpha) }
      for (k, id) in fxyIds.enumerated() {
        let term = vocab[id]
        out.fxy.update(term, default: 0) { $0 += Double(fxyCounts[k]) }
        out.fy.update(term, default: 0) { $0 += Double(counts[id]) }
      }
    }
    return Contexts(counts: out, unavailable: nil)
  }
}
