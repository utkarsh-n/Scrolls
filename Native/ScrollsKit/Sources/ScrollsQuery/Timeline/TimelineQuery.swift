// OWNER: N3
// Port of query.mjs `timelineQuery` (SPEC §7.2 POST /api/timeline/query): lanes (label · unit · coverage), units,
// extent, the conservation totals with every default exclusion counted, the modality seam, the gates, the strand extras
// (Ngram baseline link, Wiktionary claim markers) and the provenance block of a resolved def. Context-group lanes (C1)
// answer one lane per group (+ residual) with their lane state. The Term trail's lane set (C2) and its OpenAlex share
// cells (C3) are M2 and answer NOT_IMPLEMENTED until then.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore
import Synchronization

/// The Ngram baseline's availability for a strand extra (the store is N2's: STEMM attaches it).
public enum BaselineProbe {
  /// What `ngram.series(word, {lang: 'en'})` says about availability: available, or why not.
  public typealias Probe = @Sendable (_ word: String) -> (available: Bool, reason: String?)
  private static let probe = Mutex<Probe?>(nil)

  /// Installs the probe of the attached Ngram store (N2's baseline module).
  public static func install(_ p: Probe?) { probe.withLock { $0 = p } }

  /// The reference's answer for a word: the store's, or "not staged" when no store is attached.
  public static func availability(_ word: String) -> (available: Bool, reason: String?) {
    let raw = JSString.trim(word)
    if raw.isEmpty { return (false, "no word given") }
    if raw.unicodeScalars.contains(where: { JSText.isSpace($0.value) }) { return (false, "single words only") }
    if let p = probe.withLock({ $0 }) { return p(raw) }
    return (false, "The Ngram store is not staged (sources/ngram-baseline/ngram-eng-1.sqlite).")
  }

  /// `encodeURIComponent(s)`.
  public static func encodeURIComponent(_ s: String) -> String {
    let unreserved = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()".utf8)
    var out = ""
    for b in s.utf8 {
      if unreserved.contains(b) { out.append(Character(Unicode.Scalar(b))) } else { out += String(format: "%%%02X", b) }
    }
    return out
  }
}

/// The timeline query.
public enum TimelineQuery {
  static let cellSampleNote = "Top-cited sample: 200 works per field × period. Counts only on the Scroll: rates across its cells are not comparable; within-cell shares are in Compare."
  static let shareGate = Vocab.coverageGates["sampled_works"] ?? 20

  /// A lane while it is being counted.
  struct LaneAcc {
    var key: String
    var value: String?
    var uc: String
    var label: String
    var unit: String
    var n = 0
    var docs = 0
    var firstRow: DocRow?
    var lastRow: DocRow?
    var undated = 0
    var scheduled = 0
    var dated = 0
    var names = 0
    var synthetic = false
    var strands = OrderedDict<String, StrandAcc>()
    var coverage: CubeCoverage?
  }

  struct StrandAcc {
    var n = 0, docs = 0, dated = 0, undated = 0, scheduled = 0, names = 0
    var first: DocRow?
    var last: DocRow?
    var washes: [String: Int] = Slices.tierCounts([:])
  }

  /// A lane's JSON with what ordering and the extent need.
  struct LaneOut {
    var lane: Lane
    var firstDay: Int?
    var lastDay: Int?
    var yLo: Int?
    var yHi: Int?
  }

  static func formatAmount(_ n: Double) -> String {
    if !(n > 0) { return "0" }
    if n < 1000 { return JSNumber.format(n) }
    if n < 1e6 { return "\(JSNumber.format(JSNumber.parse(JSNumber.toFixed(n / 1e3, n < 1e4 ? 1 : 0))))k" }
    return "\(JSNumber.format(JSNumber.parse(JSNumber.toFixed(n / 1e6, n < 1e7 ? 1 : 0))))M"
  }

  static func firstOf(_ r: DocRow?) -> LaneEndpoint? {
    r.map { LaneEndpoint(label: $0.dateLabel, precision: $0.precision, loDay: $0.loDay, basis: $0.basis, document: DocumentID(rawValue: $0.doc)) }
  }
  static func lastOf(_ r: DocRow?) -> LaneEndpoint? {
    r.map { LaneEndpoint(label: $0.dateLabel, precision: $0.precision, hiDay: $0.hiDay, basis: $0.basis, document: DocumentID(rawValue: $0.doc)) }
  }

  static func laneJSON(_ def: QueryDef, _ l: LaneAcc, _ gates: LaneGates, _ pending: Set<String>) -> LaneOut {
    let c = l.coverage
    let unitWord = l.uc == "titles" || l.uc == "cells" ? "works" : "tokens"
    let amount = c.map { unitWord == "works" ? Double($0.docs) : $0.tokens } ?? 0
    let span: [Int]? = c.flatMap { cv in cv.spanLo.flatMap { lo in cv.spanHi.map { [lo, $0] } } }
    let spanText = span.map { ", \(DateLabels.yearLabel($0[0]))–\(DateLabels.yearLabel($0[1]))" } ?? ""
    let modality = l.uc == "cells" ? "abstracts" : l.uc == "none" ? "lexical" : l.uc
    let selection = c.flatMap { Lanes.selectionNote(JSString.split($0.samplings, ",")) }
    let head = def.lanes.facet == "modality" || def.lanes.facet == "trail" || l.uc != "text" ? l.label : "\(l.label) · \(modality)"
    let word = amount == 1 && JSString.hasSuffix(unitWord, "s") ? JSText.slice(unitWord, 0, -1) : unitWord
    let header = "\(head) · \(formatAmount(amount)) \(word)\(spanText)\(selection.map { " · \($0)" } ?? "")"
    var coverage: JSONObject = [unitWord: .number(amount), "docs": .int(c?.docs ?? 0),
                                "span": span.map { .array($0.map { JSONValue.int($0) }) } ?? .null]
    if unitWord != "works" { coverage["outside_chronology_tokens"] = .number(c?.outsideTokens ?? 0) }
    let first = l.firstRow, last = l.lastRow
    var lane = Lane(key: l.key, label: .text(l.label), unit: l.unit, modality: modality, orderRule: def.lanes.order,
                    coverage: .object(coverage), n: l.n, docs: l.docs, first: firstOf(first), last: lastOf(last),
                    undated: l.undated, scheduled: l.scheduled,
                    undatedShare: l.n > 0 ? JSNumber.round(Double(l.undated) / Double(l.n) * 1000) / 1000 : 0,
                    censor: LaneCensor(
                      left: first.map { f in c?.binLo.map { DayMath.floorDiv(f.yLo ?? 0, 10) <= $0 } ?? false } ?? false,
                      right: last.map { la in c?.binHi.map { DayMath.floorDiv(la.yHi ?? 0, 10) >= $0 } ?? false } ?? false),
                    synthetic: l.synthetic)
    lane.header = header
    if l.n > 0 && Double(l.undated) / Double(l.n) >= 0.2 {
      lane.undatedWarning = "⚠ \(JSNumber.format(JSNumber.round(Double(l.undated) / Double(l.n) * 100)))% of matches undated"
    } else {
      lane.$undatedWarning = .null
    }
    if l.uc == "none" { lane.$gate = .null } else { lane.gate = l.uc == "cells" ? shareGate : gates.of(l.key, l.uc) }
    lane.namesExcluded = def.toggle("nm") == 1 ? 0 : l.names
    var strands: [String: LaneStrandCounts] = [:]
    for (k, s) in l.strands.pairs {
      strands[k] = LaneStrandCounts(n: s.n, docs: s.docs, dated: s.dated, undated: s.undated, scheduled: s.scheduled,
                                    namesExcluded: s.names, first: firstOf(s.first), last: lastOf(s.last), washesByTier: s.washes)
    }
    lane.strands = strands
    if let selection { lane.selection = selection }
    if l.uc != "cells" && gates.rateless(def.denomKey(l.key, l.uc)) && def.lanes.facet != "trail" { lane.rateNote = cellSampleNote }
    if pending.contains(l.uc) {
      lane.state = "pending"
      lane.note = "indexing — not yet looked"
    }
    return LaneOut(lane: lane, firstDay: first?.loDay, lastDay: last?.hiDay, yLo: first?.yLo, yHi: last?.yHi)
  }

  /// `timelineQuery(db, {def, rev_cutoff})`: everything but the queryKey/status/job envelope.
  public static func run(_ c: Connection, _ def: QueryDef, revCutoff: Int64? = nil) throws -> TimelineQueryResponse {
    let facet = def.lanes.facet
    if facet == "trail" {
      throw ScrollsError.notImplemented(area: "The Term trail lane set (contract 1.3.0 C2/C3; package N3, milestone M2)")
    }
    let names = try c.prepared(TimelineSQL.collectionNames)
    try names.bind([.text(SQLJSON.ints(def.corpusIds))])
    var collectionNames: [String: String] = [:]
    for (slug, name) in try names.all({ ($0.text(0), $0.text(1)) }) { collectionNames[slug] = name }
    let gates = try Slices.laneGates(c, def)
    let pending = try Slices.pendingUnitClasses(c, def)
    var lanes = OrderedDict<String, LaneAcc>()
    func laneOf(_ lv: String?, _ uc: String) -> String {
      let key = Lanes.key(facet, lv, uc)
      if lanes[key] == nil {
        lanes[key] = LaneAcc(key: key, value: lv, uc: uc, label: Lanes.label(facet, lv, uc, collectionNames: collectionNames),
                             unit: Rates.unitOf(uc))
      }
      return key
    }
    var totals = (n: 0, dated: 0, undated: 0, scheduled: 0, names: 0, sampled: false, washes: Slices.tierCounts([:]),
                  matches: 0, works: 0)
    for strand in def.strands {
      if strand.sampled { totals.sampled = true }
      for r in try Slices.strandDocRows(c, def, strand) {
        let key = laneOf(r.lv, r.uc)
        var l = lanes[key]!
        var s = l.strands[strand.key] ?? StrandAcc()
        defer {
          l.strands[strand.key] = s
          lanes[key] = l
        }
        let amount = Slices.countValue(r.uc, r.v)
        if def.toggle("nm") == 0 {
          s.names += r.names
          l.names += r.names
          totals.names += r.names
        }
        if amount == 0 { continue }
        s.n += amount
        l.n += amount
        totals.n += amount
        if r.uc == "titles" || r.uc == "cells" { totals.works += amount } else { totals.matches += amount }
        s.docs += 1
        l.docs += 1
        if r.syn { l.synthetic = true }
        if r.chronoStatus == "undated" {
          s.undated += amount
          l.undated += amount
          totals.undated += amount
          continue
        }
        if r.chronoStatus == "scheduled" {
          s.scheduled += amount
          l.scheduled += amount
          totals.scheduled += amount
          continue
        }
        s.dated += amount
        l.dated += amount
        totals.dated += amount
        if r.uc != "cells" {
          for t in Slices.tiers where !Slices.fitsTier(yLo: r.yLo, yHi: r.yHi, loDay: r.loDay, hiDay: r.hiDay, t) {
            s.washes[t]! += amount
            totals.washes[t]! += amount
          }
        }
        if s.first == nil || (r.loDay ?? 0) < (s.first!.loDay ?? 0) { s.first = r }
        if s.last == nil || (r.hiDay ?? 0) > (s.last!.hiDay ?? 0) { s.last = r }
        if l.firstRow == nil || (r.loDay ?? 0) < (l.firstRow!.loDay ?? 0) { l.firstRow = r }
        if l.lastRow == nil || (r.hiDay ?? 0) > (l.lastRow!.hiDay ?? 0) { l.lastRow = r }
      }
    }
    let coverage = try CubeSlice.coverage(c, def, def.coverageLangs)
    if facet == "cluster" {
      for key in lanes.keys { lanes[key]!.coverage = coverage.first { $0.uc == lanes[key]!.uc } }
    } else {
      for r in coverage {
        let key = laneOf(r.lv, r.uc)
        lanes[key]!.coverage = r
        if r.syn { lanes[key]!.synthetic = true }
      }
    }
    let all = lanes.values.map { laneJSON(def, $0, gates, pending) }
    var ordered: [LaneOut]
    var visible: [LaneOut]
    var folded: [LaneOut] = []
    var extra: (state: String?, note: String?, setNote: Bool, suggestion: JSONValue?, gate: JSONValue?, cluster: JSONValue?) =
      (nil, nil, false, nil, nil, nil)
    if facet == "cluster" {
      let r = try clusterLaneSet(c, def, all, gates: gates, pending: pending, revCutoff: revCutoff, coverage: coverage)
      visible = r.visible
      ordered = visible
      extra = (r.state, r.note, r.setNote, r.suggestion, r.gate, r.cluster)
    } else {
      ordered = Lanes.order(all, rule: def.lanes.order, manual: def.lanes.manual) { l in
        Lanes.Orderable(key: l.lane.key, label: l.lane.label.text ?? "", n: l.lane.n, firstDay: l.firstDay)
      }
      visible = Array(ordered.prefix(def.lanes.max))
      folded = Array(ordered.dropFirst(def.lanes.max))
    }
    var units: [UnitLanes] = []
    for l in visible {
      if let i = units.firstIndex(where: { $0.unit == l.lane.unit }) { units[i].lanes.append(l.lane.key) } else {
        units.append(UnitLanes(unit: l.lane.unit, lanes: [l.lane.key]))
      }
    }
    let observed = ordered.filter { $0.yLo != nil }
    let yLo = observed.compactMap(\.yLo).min(), yHi = observed.compactMap(\.yHi).max()
    let dayLo = observed.compactMap(\.firstDay).min(), dayHi = observed.compactMap(\.lastDay).max()
    let extras = try strandExtras(c, def)
    var extent = Extent(from: yLo.map(DateLabels.yearLabel), to: yHi.map(DateLabels.yearLabel))
    extent.$fromDay = dayLo.map { .value($0) } ?? .null
    extent.$toDay = dayHi.map { .value($0) } ?? .null
    let tt = TimelineTotals(n: totals.n, dated: totals.dated, undated: totals.undated, scheduled: totals.scheduled,
                            namesExcluded: totals.names, sampled: totals.sampled, washesByTier: totals.washes,
                            byUnit: UnitTotals(matches: totals.matches, works: totals.works),
                            unitsMixed: totals.matches > 0 && totals.works > 0, excluded: try Slices.excludedCounts(c, def))
    let tokensGate = gates.byUnit["text"] ?? gates.byUnit["abstracts"]
    let gatesJSON: JSONValue = .object([
      "rates": .object(["gate": "ok", "coverage_gate": .object(["tokens": .int(tokensGate), "works": .int(gates.byUnit["titles"])]),
                        "note": (gates.byUnit["text"] ?? 50000) < 50000 ? "demo setting; real collections use 50,000 tokens" : .null]),
      "cluster": clusterGate(def),
    ])
    var out = TimelineQueryResponse(queryKey: "", dataVersion: try Slices.dataVersion(c), status: "ready", job: nil, units: units,
                                    lanes: visible.map(\.lane),
                                    other: OtherLanes(lanes: folded.count, n: folded.reduce(0) { $0 + $1.lane.n }, keys: folded.map(\.lane.key)),
                                    extent: extent, totals: tt, seams: try seams(c, def, visible.map(\.lane)), gates: gatesJSON,
                                    provenance: try Slices.provenance(c, def))
    if def.strands.contains(where: \.sampled) {
      out.samplingNote = "Very frequent: counts are complete; contexts (marks, KWIC, drawer rows) are a stratified sample of ≤ 200 per language and decade."
        + (def.strands.contains(where: \.accentInsensitive) ? " Counts include accent variants (counted from the search index)." : "")
    } else {
      out.$samplingNote = .null
    }
    if def.timeBasis == "referenced" {
      out.timeBasisNote = "Referenced time is not available on the timeline yet; publication time is shown."
    } else {
      out.$timeBasisNote = .null
    }
    out.laneOrderNote = def.lanes.facet == "trail" ? TrailLanes.orderNote : Lanes.orderNote(def.lanes.order)
    if let s = extra.state { out.laneState = s }
    if extra.setNote { out.$laneNote = extra.note.map { .value($0) } ?? .null }
    if let s = extra.suggestion { out.$suggestion = s == .null ? .null : .value(s) }
    if let g = extra.gate { out.gate = g }
    if let cl = extra.cluster { out.cluster = cl }
    out.$baseline = extras.baseline.map { .value($0) } ?? .null
    out.claims = extras.claims
    out.strandExtras = extras.byStrand
    return out
  }

  /// `clusterGate(def)`.
  static func clusterGate(_ def: QueryDef) -> JSONValue {
    guard let cl = def.cluster else {
      return .object(["gate": "not_run", "needed": .object(["run": "cluster"]), "have": .object(["runs": 0]), "suggestion": .null])
    }
    if cl.state == "ok" { return .object(["gate": "ok", "run": .int(cl.run)]) }
    if cl.state == "gated", let g = cl.gate { return g }
    return .object(["gate": "not_run", "needed": .object(["run": "cluster"]), "have": .object(["runs": 0]),
                    "suggestion": cl.suggestion ?? .null])
  }

  /// `clusterLaneSet`: one lane per group of the run in `ord` order, then the residual lane.
  static func clusterLaneSet(_ c: Connection, _ def: QueryDef, _ all: [LaneOut], gates: LaneGates, pending: Set<String>,
                             revCutoff: Int64?, coverage: [CubeCoverage])
    throws -> (visible: [LaneOut], state: String, note: String?, setNote: Bool, suggestion: JSONValue?, gate: JSONValue?, cluster: JSONValue?)
  {
    guard let cl = def.cluster, cl.state == "ok" else {
      let cl = def.cluster
      let state = cl?.state ?? "unavailable"
      return ([], state, cl?.note, true, state == "not_run" ? (cl?.suggestion ?? .null) : nil, state == "gated" ? cl?.gate : nil, nil)
    }
    var byKey: [String: LaneOut] = [:]
    for l in all { byKey[l.lane.key] = l }
    var ucs: [String] = []
    for l in all where ["text", "titles", "abstracts"].contains(l.lane.modality) && !ucs.contains(l.lane.modality) {
      ucs.append(l.lane.modality)
    }
    if ucs.isEmpty { ucs.append("text") }
    var visible: [LaneOut] = []
    for g in try ClusterLanes.groupLanes(c, cl, revCutoff: revCutoff) {
      for uc in ucs {
        let key = Lanes.key("cluster", g.value, uc)
        var l = byKey[key] ?? laneJSON(def, LaneAcc(key: key, value: g.value, uc: uc, label: g.text, unit: Rates.unitOf(uc),
                                                    coverage: coverage.first { $0.uc == uc }), gates, pending)
        l.lane.label = .group(machine: g.machine, human: g.human)
        l.lane.labelText = uc == "text" ? g.text : "\(g.text) · \(uc)"
        l.lane.$clusterId = g.clusterId.map { .value(Int($0)) } ?? .null
        l.lane.$ord = g.ord.map { .value($0) } ?? .null
        l.lane.run = cl.run.map { RunID(rawValue: $0) }
        l.lane.status = g.status
        l.lane.tentative = g.tentative
        l.lane.$stability = g.stability.map { .value($0) } ?? .null
        l.lane.groupSize = g.size
        l.lane.note = "machine label (editable) — a computed hypothesis over context words, not a meaning"
        visible.append(l)
      }
    }
    let run = cl.run ?? 0
    let info: JSONValue = .object(["run": .int(run), "groups": .int(cl.groups.count), "residual_groups": .int(cl.residual.count),
                                   "href": .string("/api/clusters?expr=\(def.strands[0].ref)&run=\(run)"),
                                   "note": "Transitions (split, merge, emerge, vanish) are on GET /api/clusters."])
    return (visible, "ok", nil, false, nil, nil, info)
  }

  /// `seamsFor(db, def, lanes)`: the text → titles modality seam.
  public static func seams(_ c: Connection, _ def: QueryDef, _ lanes: [Lane]) throws -> [Seam] {
    let mods = Set(lanes.map(\.modality))
    guard mods.contains("text"), mods.contains("titles") || mods.contains("abstracts") else { return [] }
    let exprs = def.strands.filter { $0.type == "expression" }
    let langs: [String]? = !exprs.isEmpty && exprs.allSatisfy({ $0.langs != nil })
      ? Array(Set(exprs.flatMap { $0.langs! })).sorted(by: CanonicalJSON.codeUnitLess) : nil
    guard let last = try CubeSlice.lastTextYear(c, def, langs) else { return [] }
    return [Seam(kind: "modality", year: last + 1, lastCoveredYear: last,
                 label: "Full text ends \(last) → after this line the evidence is titles and abstracts: a change of medium, not of meaning.",
                 collapsible: true, hideable: false)]
  }

  /// `strandExtras(db, def)`: the Ngram baseline link and Wiktionary claim markers of each real expression strand.
  public static func strandExtras(_ c: Connection, _ def: QueryDef) throws -> (baseline: BaselineLink?, claims: [ClaimMarker], byStrand: JSONValue) {
    var by = OrderedDict<String, (baseline: BaselineLink?, claims: [ClaimMarker])>()
    for s in def.strands where s.type == "expression" && !s.synthetic {
      let single = s.kind == "word"
      let english = JSString.split(s.lang ?? "", "-")[0] == "en"
      var baseline: BaselineLink?
      if single && english {
        let b = BaselineProbe.availability(s.surface ?? "")
        baseline = BaselineLink(available: b.available, href: "/api/baseline?word=\(BaselineProbe.encodeURIComponent(s.surface ?? ""))&lang=en",
                                reason: b.available ? nil : b.reason)
        if !b.available && b.reason == nil { baseline?.$reason = .null }
      } else if !single {
        baseline = BaselineLink(available: false, href: nil, reason: "No external baseline: the Ngram store holds single words only.")
      }
      var seen = Set<String>()
      var claims: [ClaimMarker] = []
      for m in s.members ?? [StrandMember(corpusId: 0, corpus: "", ref: s.exprId, run: nil, langs: nil, sampled: false, accentInsensitive: false)] {
        guard let ref = m.ref else { continue }
        for cm in try Expressions.claims(c, ref) {
          let k = "\(cm.label)|\(cm.date.loYear.map(String.init) ?? "null")|\(cm.date.hiYear.map(String.init) ?? "null")"
          if seen.insert(k).inserted { claims.append(cm) }
        }
      }
      claims = stableSorted(claims) { a, b in
        let da = a.display == "default" ? 0 : 1, db = b.display == "default" ? 0 : 1
        if da != db { return da < db }
        return (a.date.loYear ?? 0) < (b.date.loYear ?? 0)
      }
      by[s.key] = (baseline, claims)
    }
    let first = by.values.first { $0.baseline != nil || !$0.claims.isEmpty }
    let byJSON = JSONObject(try by.pairs.map { (k, v) in
      (k, JSONValue.object(["baseline": try v.baseline.map { try ScrollsJSON.value($0) } ?? .null,
                            "claims": .array(try v.claims.map { try ScrollsJSON.value($0) })]))
    })
    return (first?.baseline, first?.claims ?? [], .object(byJSON))
  }
}

extension LaneLabel {
  /// The text of a plain label.
  var text: String? { if case .text(let s) = self { return s } else { return nil } }
}
