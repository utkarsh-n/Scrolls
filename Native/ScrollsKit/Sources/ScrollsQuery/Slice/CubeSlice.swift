// OWNER: N3
// The slice over the cube's columns (cube.mjs slicePredicate / laneGroups / cubeDenominators / cubeCoverage /
// cubeGateRows / cubeLastTextYear / cubeRangeTotals / cubeCorpusSize, and the several-corpora sums). The predicate is
// SliceSQL's docWhere + rowWhere over columns; tests check cube = SQL denominators on random slices.

import ScrollsCore
import ScrollsStore

/// A lane of a cube row group.
public struct CubeLane: Sendable, Equatable {
  public var lv: String?
  public var uc: String
  public var key: String
}

extension SliceCube {
  /// `allowList(values, list)`: allowed codes under an include/exclude list (`IN` never matches NULL; `NOT IN` keeps it).
  static func allowList(_ values: [String?], _ list: [String]) -> [Bool] {
    let (inc, exc) = SliceSQL.includeExclude(list)
    return values.map { v in
      guard let v else { return inc.isEmpty }
      return (inc.isEmpty || inc.contains(v)) && !exc.contains(v)
    }
  }

  /// RF-1 over the dictionaries: unidentified plang codes, running-text field classes, admitted document languages.
  func languageGate(_ langs: [String]) -> (und: [Bool], textFC: [Bool], docOK: [Bool]) {
    (dicts["plang"]!.map { $0 != nil && LangGate.isUnidentified($0) },
     SliceCube.fieldClasses.map { LangGate.docTextClasses.contains($0) },
     dicts["dlang"]!.map { LangGate.isUnidentified($0) || ($0.map { langs.contains($0) } ?? false) })
  }

  /// The Term trail lane value of each row (computed once per collection × field × field class).
  func trailValues() -> (Int) -> String? {
    let nf = dicts["field"]!.count + 1
    var memo: [Int: String?] = [:]
    return { [self] r in
      let code = (Int(coll[r]) * nf + Int(field[r])) * 5 + Int(fc[r])
      if let v = memo[code] { return v }
      let c = colls[Int(coll[r])]
      let v = TrailLanes.value(sampling: c.sampling, domain: c.domain, field: dicts["field"]![Int(field[r])],
                               fieldClass: SliceCube.fieldClasses[Int(fc[r])])
      memo[code] = v
      return v
    }
  }

  /// `slicePredicate(cube, def, langs)`: SliceSQL.sliceWhere over the cube's rows.
  func predicate(_ def: QueryDef, _ langs: LangSpec) -> (Int) -> Bool {
    let f = def.f
    let trail = def.lanes.facet == "trail"
    let kindOK = Self.allowList(dicts["kind"]!, f.kind)
    let cultureOK = Self.allowList(dicts["culture"]!, f.culture)
    let fieldOK = Self.allowList(dicts["field"]!, f.field)
    let communityOK = Self.allowList(dicts["community"]!, f.community)
    var basisOK = Self.allowList(dicts["basis"]!, f.basis)
    if def.toggle("est") == 0 { for (i, v) in dicts["basis"]!.enumerated() where v == "estimated" { basisOK[i] = false } }
    var collOK = Self.allowList(colls.map { Optional($0.slug) }, f.coll)
    for (i, c) in colls.enumerated() where !c.rateEligible && !(trail && c.sampling == "relation_endpoints") { collOK[i] = false }
    var plangOK = Self.allowList(dicts["plang"]!, f.lang)
    let here = langs.forCorpus(corpusId)
    if let here { for (i, v) in dicts["plang"]!.enumerated() where !(v.map { here.contains($0) } ?? false) { plangOK[i] = false } }
    plangOK[0] = false
    let lg = here.map { languageGate($0) }
    let classes = Set(def.fieldClasses)
    let fcOK = SliceCube.fieldClasses.map { classes.contains($0) }
    let deny: UInt8 = (def.toggle("tr") == 1 ? 0 : SliceCube.fTR) | (def.toggle("dup") == 1 ? 0 : SliceCube.fDUP)
      | (f.syn == 0 ? SliceCube.fSYN : 0)
    let cut = Int32(def.cutoffs?.importBatch ?? 0)
    let savedAt = SliceCube.epochSeconds(def.cutoffs?.at)
    let tv = trail ? trailValues() : nil
    return { [self] r in
      let fcr = Int(fc[r])
      guard fcr < fcOK.count, fcOK[fcr], plangOK[Int(plang[r])], flags[r] & deny == 0, Int(coll[r]) < collOK.count, collOK[Int(coll[r])],
        kindOK[Int(kind[r])], basisOK[Int(basis[r])], cultureOK[Int(culture[r])], fieldOK[Int(field[r])],
        communityOK[Int(community[r])], cut == 0 || batch[r] <= cut, del[r] == 0 || (savedAt > 0 && del[r] > savedAt)
      else { return false }
      if let lg, !(lg.docOK[Int(dlang[r])] || !lg.und[Int(plang[r])] || !lg.textFC[fcr]) { return false }
      if let tv, tv(r) == nil { return false }
      return true
    }
  }

  /// `laneGroups(cube, facet)`: a small integer per (value, unit class) and its lane (nil outside every lane).
  func laneGroups(_ facet: String) -> (group: (Int) -> Int, lane: (Int) -> CubeLane?) {
    if facet == "trail" {
      let tv = trailValues()
      var ids: [String?: Int] = [:]
      var back: [CubeLane?] = []
      return ({ r in
        let v = tv(r)
        if let g = ids[v] { return g }
        let g = back.count
        ids[v] = g
        back.append(v.map { CubeLane(lv: $0, uc: TrailLanes.unitClass($0), key: "trail:\($0)") })
        return g
      }, { back[$0] })
    }
    if facet == "cluster" {
      let lanes = SliceCube.unitClasses.map { CubeLane(lv: nil, uc: $0, key: "~\($0)") }
      return ({ [self] r in SliceCube.unitOfFC[Int(fc[r])] }, { lanes[$0] })
    }
    let values: [String?]
    let codeOf: (Int) -> Int
    func byColl(_ attr: (CubeCollection) -> String?) -> ([String?], (Int) -> Int) {
      var vals: [String?] = []
      for c in colls where !vals.contains(where: { $0 == attr(c) }) { vals.append(attr(c)) }
      let map = colls.map { c in vals.firstIndex { $0 == attr(c) }! }
      return (vals, { [self] r in map[Int(coll[r])] })
    }
    switch facet {
    case "domain": (values, codeOf) = byColl { $0.domain }
    case "collection": (values, codeOf) = byColl { $0.slug }
    case "community": (values, codeOf) = (dicts["community"]!, { [self] r in Int(community[r]) })
    case "kind": (values, codeOf) = (dicts["kind"]!, { [self] r in Int(kind[r]) })
    case "culture": (values, codeOf) = (dicts["culture"]!, { [self] r in Int(culture[r]) })
    case "field": (values, codeOf) = (dicts["field"]!, { [self] r in Int(field[r]) })
    case "date_basis": (values, codeOf) = (dicts["basis"]!, { [self] r in Int(basis[r]) })
    case "modality": (values, codeOf) = (SliceCube.unitClasses, { [self] r in SliceCube.unitOfFC[Int(fc[r])] })
    case "language": (values, codeOf) = (dicts["plang"]!, { [self] r in Int(plang[r]) })
    default: (values, codeOf) = ([nil], { _ in 0 })
    }
    var lanes: [Int: CubeLane] = [:]
    return ({ [self] r in codeOf(r) * 3 + SliceCube.unitOfFC[Int(fc[r])] }, { g in
      if let l = lanes[g] { return l }
      let lv = values[safe: g / 3] ?? nil, uc = SliceCube.unitClasses[g % 3]
      let l = CubeLane(lv: lv, uc: uc, key: Lanes.key(facet, lv, uc))
      lanes[g] = l
      return l
    })
  }

  static func sliceKey(_ def: QueryDef, _ langs: LangSpec?) -> String {
    let cut = def.cutoffs.map { "\($0.importBatch.map(String.init) ?? "-")|\($0.at ?? "-")" } ?? "null"
    return "\(def.corpusId)|\(CanonicalJSON.string(QueryDef.filtersJSON(def.f)))|\(def.toggles.map { "\($0.key)=\($0.value)" }.joined(separator: ","))|\(cut)|\(langs?.key ?? "null")"
  }

  /// The bin of a day at a tier (L0–L3 by year, L4 month, L5 day).
  static func binOfDay(_ day: Int, _ year: Int, _ level: Int) -> Int {
    if level <= 3 { return DayMath.floorDiv(year, [1000, 100, 10, 1][level]) }
    return level == 4 ? Bins.monthBinOfDay(day) : day
  }

  /// `cubeDenominators(cube, def, langs, tier)`: `lane|bin` → denominator over documents that fit the bin.
  func denominators(_ def: QueryDef, _ langs: LangSpec, _ tier: String) -> OrderedDict<String, CubeDenominator> {
    memoized("den|\(Self.sliceKey(def, langs))|\(def.lanes.facet)|\(tier)") {
      let level = Vocab.tiers.firstIndex(of: tier) ?? 2
      let pass = predicate(def, langs)
      let lanes = laneGroups(def.lanes.facet)
      let w = level <= 3 ? [1000, 100, 10, 1][level] : 0
      var out = OrderedDict<String, CubeDenominator>()
      var last: [String: Int32] = [:]
      for r in 0..<n {
        if cs[r] != 0 || !pass(r) { continue }
        let bin: Int
        if level <= 3 {
          bin = DayMath.floorDiv(Int(ylo[r]), w)
          if bin != DayMath.floorDiv(Int(yhi[r]), w) { continue }
        } else {
          if Int(hid[r]) - Int(lod[r]) > 30 { continue }
          guard let fits = try? Bins.fitsDays(Int(lod[r]), Int(hid[r]), level == 4 ? .month : .day), fits else { continue }
          bin = SliceCube.binOfDay(Int(lod[r]), Int(ylo[r]), level)
        }
        guard let l = lanes.lane(lanes.group(r)) else { continue }
        let k = "\(l.key)|\(bin)"
        var a = out[k] ?? CubeDenominator(lane: l.key, uc: l.uc, bin: bin, tokens: 0, docs: 0, syn: false, tr: false)
        a.tokens += tokens[r]
        if last[k] != doc[r] {
          a.docs += 1
          last[k] = doc[r]
        }
        if flags[r] & SliceCube.fSYN != 0 { a.syn = true }
        if flags[r] & SliceCube.fTR != 0 { a.tr = true }
        out[k] = a
      }
      return out
    }
  }

  /// `cubeCoverage(cube, def, langs)`: per lane, tokens, documents, spans, decade-bin span, samplings.
  func coverage(_ def: QueryDef, _ langs: LangSpec) -> [CubeCoverage] {
    memoized("cov|\(Self.sliceKey(def, langs))|\(def.lanes.facet)") {
      let pass = predicate(def, langs)
      let lanes = laneGroups(def.lanes.facet)
      var out = OrderedDict<Int, (cov: CubeCoverage, samplings: Set<String>, last: Int32)>()
      for r in 0..<n {
        if !pass(r) { continue }
        let g = lanes.group(r)
        var a: (cov: CubeCoverage, samplings: Set<String>, last: Int32)
        if let x = out[g] { a = x } else {
          guard let l = lanes.lane(g) else { continue }
          a = (CubeCoverage(lv: l.lv, uc: l.uc, tokens: 0, docs: 0, spanLo: nil, spanHi: nil, binLo: nil, binHi: nil, syn: false,
                            samplings: "", outsideTokens: 0), [], -1)
        }
        a.cov.tokens += tokens[r]
        if a.last != doc[r] {
          a.cov.docs += 1
          a.last = doc[r]
        }
        if cs[r] == 0 {
          let lo = Int(ylo[r]), hi = Int(yhi[r])
          if a.cov.spanLo == nil || lo < a.cov.spanLo! { a.cov.spanLo = lo }
          if a.cov.spanHi == nil || hi > a.cov.spanHi! { a.cov.spanHi = hi }
          let b = DayMath.floorDiv(lo, 10)
          if b == DayMath.floorDiv(hi, 10) {
            if a.cov.binLo == nil || b < a.cov.binLo! { a.cov.binLo = b }
            if a.cov.binHi == nil || b > a.cov.binHi! { a.cov.binHi = b }
          }
        } else {
          a.cov.outsideTokens += tokens[r]
        }
        if flags[r] & SliceCube.fSYN != 0 { a.cov.syn = true }
        if let s = colls[Int(coll[r])].sampling { a.samplings.insert(s) }
        out[g] = a
      }
      return out.values.map { x in
        var c = x.cov
        c.samplings = x.samplings.sorted(by: CanonicalJSON.codeUnitLess).joined(separator: ",")
        return c
      }
    }
  }

  /// `cubeGateRows(cube, def)`: (lane, collection) pairs of the slice in every language.
  func gateRows(_ def: QueryDef) -> [CubeGateRow] {
    memoized("gate|\(Self.sliceKey(def, nil))|\(def.lanes.facet)") {
      let pass = predicate(def, .any)
      let lanes = laneGroups(def.lanes.facet)
      var seen = Set<Int>()
      var out: [CubeGateRow] = []
      for r in 0..<n {
        if !pass(r) { continue }
        let g = lanes.group(r), c = Int(coll[r])
        let k = g * (colls.count + 1) + c
        if !seen.insert(k).inserted { continue }
        guard let l = lanes.lane(g) else { continue }
        let col = colls[c]
        out.append(CubeGateRow(lv: l.lv, uc: l.uc, unit: col.unit, coverageGate: col.coverageGate, sampling: col.sampling))
      }
      return out
    }
  }

  /// `cubeLastTextYear(cube, langs)`: the latest y_hi of a dated live document with text tokens (mostly in `langs`).
  func lastTextYear(_ langs: [String]?) -> Int? {
    memoized("seam|\(langs.map { CanonicalJSON.string(.array($0.map(JSONValue.string))) } ?? "null")") {
      let inLang = langs.map { l in dicts["plang"]!.map { $0.map { l.contains($0) } ?? false } }
      let lg = langs.map { languageGate($0) }
      var last: Int?
      var r = 0
      while r < n {
        let d = doc[r]
        var total = 0.0, mine = 0.0, any = false
        let dated = cs[r] == 0 && del[r] == 0, y = Int(yhi[r])
        while r < n && doc[r] == d {
          defer { r += 1 }
          if fc[r] != 0 { continue }
          total += tokens[r]
          if tokens[r] > 0 { any = true }
          if let inLang, let lg, inLang[Int(plang[r])], !lg.und[Int(plang[r])] || lg.docOK[Int(dlang[r])] { mine += tokens[r] }
        }
        if !dated || !any || (inLang != nil && !(2 * mine > total)) { continue }
        if last == nil || y > last! { last = y }
      }
      return last
    }
  }

  /// `cubeRangeTotals(cube, def, langs, {from, to, lane})`: tokens, works and documents a concordance looked at.
  func rangeTotals(_ def: QueryDef, _ langs: LangSpec, from: Int?, to: Int?, lane: String?) -> (tokens: Double, works: Int, docs: Int) {
    let pass = predicate(def, langs)
    let lanes = laneGroups(def.lanes.facet)
    let ranged = from != nil || to != nil
    var t = 0.0, works = 0, docs = 0
    var lastDoc: Int32 = -1, lastWork: Int32 = -1
    for r in 0..<n {
      if !pass(r) { continue }
      if ranged && (cs[r] != 0 || (from.map { Int(yhi[r]) < $0 } ?? false) || (to.map { Int(ylo[r]) > $0 } ?? false)) { continue }
      if let lane, lanes.lane(lanes.group(r))?.key != lane { continue }
      if SliceCube.unitOfFC[Int(fc[r])] == 1 {
        if lastWork != doc[r] {
          works += 1
          lastWork = doc[r]
        }
      } else {
        t += tokens[r]
      }
      if lastDoc != doc[r] {
        docs += 1
        lastDoc = doc[r]
      }
    }
    return (t, works, docs)
  }

  /// `cubeCorpusSize(cube, langs)`: full-text tokens, works with a title, and the last year with full text.
  func corpusSize(_ langs: [String]?) -> (tokens: Double, works: Int, lastText: Int?) {
    memoized("size|\(langs.map { CanonicalJSON.string(.array($0.map(JSONValue.string))) } ?? "null")") {
      var t = 0.0, works = 0
      var lastWork: Int32 = -1
      for r in 0..<n where del[r] == 0 {
        if fc[r] == 0 { t += tokens[r] } else if fc[r] == 1 && lastWork != doc[r] {
          works += 1
          lastWork = doc[r]
        }
      }
      return (t, works, lastTextYear(langs))
    }
  }
}

/// Aggregates over every corpus of a def (a virtual corpus reads one cube per member and adds them up).
public enum CubeSlice {
  /// `sliceDenominators(db, def, langs, tier)`.
  public static func denominators(_ c: Connection, _ def: QueryDef, _ langs: LangSpec, _ tier: String) throws -> OrderedDict<String, CubeDenominator> {
    let cubes = try Cubes.of(c, def)
    if cubes.count == 1 { return cubes[0].denominators(def, langs, tier) }
    var out = OrderedDict<String, CubeDenominator>()
    for cube in cubes {
      for (k, d) in cube.denominators(def, langs, tier).pairs {
        if var a = out[k] {
          a.tokens += d.tokens
          a.docs += d.docs
          a.syn = a.syn || d.syn
          a.tr = a.tr || d.tr
          out[k] = a
        } else {
          out[k] = d
        }
      }
    }
    return out
  }

  /// `sliceCoverage(db, def, langs)`.
  public static func coverage(_ c: Connection, _ def: QueryDef, _ langs: LangSpec) throws -> [CubeCoverage] {
    let cubes = try Cubes.of(c, def)
    if cubes.count == 1 { return cubes[0].coverage(def, langs) }
    var out = OrderedDict<String, CubeCoverage>()
    func lo(_ a: Int?, _ b: Int?) -> Int? { a == nil ? b : b == nil ? a : min(a!, b!) }
    func hi(_ a: Int?, _ b: Int?) -> Int? { a == nil ? b : b == nil ? a : max(a!, b!) }
    for cube in cubes {
      for cv in cube.coverage(def, langs) {
        let k = "\(cv.lv ?? "null")|\(cv.uc)"
        guard var a = out[k] else {
          out[k] = cv
          continue
        }
        a.tokens += cv.tokens
        a.docs += cv.docs
        a.outsideTokens += cv.outsideTokens
        a.syn = a.syn || cv.syn
        a.spanLo = lo(a.spanLo, cv.spanLo)
        a.spanHi = hi(a.spanHi, cv.spanHi)
        a.binLo = lo(a.binLo, cv.binLo)
        a.binHi = hi(a.binHi, cv.binHi)
        let all = Set((JSString.split(a.samplings, ",") + JSString.split(cv.samplings, ",")).filter { !$0.isEmpty })
        a.samplings = all.sorted(by: CanonicalJSON.codeUnitLess).joined(separator: ",")
        out[k] = a
      }
    }
    return out.values
  }

  /// `sliceGateRows(db, def)`.
  public static func gateRows(_ c: Connection, _ def: QueryDef) throws -> [CubeGateRow] {
    try Cubes.of(c, def).flatMap { $0.gateRows(def) }
  }

  /// `sliceLastTextYear(db, def, langs)`.
  public static func lastTextYear(_ c: Connection, _ def: QueryDef, _ langs: [String]?) throws -> Int? {
    var last: Int?
    for cube in try Cubes.of(c, def) {
      if let y = cube.lastTextYear(langs), last == nil || y > last! { last = y }
    }
    return last
  }

  /// `cubesRangeTotals(cubes, def, langs, opts)`.
  public static func rangeTotals(_ cubes: [SliceCube], _ def: QueryDef, _ langs: LangSpec, from: Int?, to: Int?,
                                 lane: String?) -> (tokens: Double, works: Int, docs: Int) {
    var out = (tokens: 0.0, works: 0, docs: 0)
    for cube in cubes {
      let t = cube.rangeTotals(def, langs, from: from, to: to, lane: lane)
      out.tokens += t.tokens
      out.works += t.works
      out.docs += t.docs
    }
    return out
  }

  /// `cubesCorpusSize(cubes, langs)`.
  public static func corpusSize(_ cubes: [SliceCube], _ langs: [String]?) -> (tokens: Double, works: Int, lastText: Int?) {
    var out: (tokens: Double, works: Int, lastText: Int?) = (0, 0, nil)
    for cube in cubes {
      let s = cube.corpusSize(langs)
      out.tokens += s.tokens
      out.works += s.works
      if let y = s.lastText, out.lastText == nil || y > out.lastText! { out.lastText = y }
    }
    return out
  }
}
