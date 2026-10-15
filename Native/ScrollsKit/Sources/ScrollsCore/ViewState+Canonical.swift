// OWNER: N0
// canonicalize() and the filter grammar of src/shared/viewstate.mjs. The input is any JSON value (a saved view, a
// decoded hash, a request body): JavaScript's loose checks (Number.isFinite, Number.isSafeInteger, `=== true`,
// Array.isArray, list.includes) are reproduced on JSONValue cases one for one, and every repair adds the reference's
// warning text.
//
// Not reproduced: the reference's plain-object lookups also see Object.prototype keys ('constructor', 'toString', …),
// so e.g. a lineage type 'toString' survives canonicalize there. Swift treats them as the unknown values they are
// (finding filed for R in Native/Docs/DIFFERENTIAL.md).

extension ViewState {
  /// `canonicalize(state, warnings)`: a validated, defaults-filled, canonical copy (unknown keys dropped, lists sorted
  /// where order carries no meaning, numbers clamped and rounded). Never fails; `warnings` receives what was dropped
  /// or repaired.
  public static func canonicalize(_ state: JSONValue, warnings: inout [String]) -> ViewState {
    let s = state.objectValue ?? [:]
    if state.objectValue == nil { warnings.append("state is not an object; defaults used") }
    var corpus: String
    if case .string(let c)? = s["corpus"], isCorpusSlug(c) {
      corpus = c
    } else {
      if let c = s["corpus"] { warnings.append("corpus '\(Vocab.jsString(c))' is not valid; 'demo' used") }
      corpus = "demo"
    }
    let d = defaultState(corpus)
    var out = d

    out.strands = canonStrands(s["strands"], &warnings)

    let L = s["lanes"]?.objectValue ?? [:]
    out.lanes.facet = oneOf(L["facet"], Vocab.laneFacets) ?? d.lanes.facet
    if let sub = oneOf(L["sub"], Vocab.laneFacets), !JSString.equal(sub, out.lanes.facet) { out.lanes.sub = sub } else { out.lanes.sub = nil }
    out.lanes.run = posInt(L["run"])
    out.lanes.order = oneOf(L["order"], Vocab.laneOrders) ?? d.lanes.order
    if out.lanes.order == "manual", case .array(let manual)? = L["manual"] {
      out.lanes.manual = uniqueInOrder(manual.compactMap { shortStr($0) }.filter { !$0.isEmpty })
    } else {
      out.lanes.manual = []
    }
    out.lanes.max = safeInt(L["max"]).map { clamp($0, 1, 48) } ?? d.lanes.max

    out.f = canonicalFilter(s["f"], &warnings)

    let T = s["toggles"]?.objectValue ?? [:]
    for (k, dflt) in Vocab.toggleDefaults { out.toggles[k] = bit(T[k], dflt) }

    out.timeBasis = oneOf(s["timeBasis"], Vocab.timeBases) ?? "publication"

    let A = s["axis"]?.objectValue ?? [:]
    switch A["mode"] {
    case .string("folded")?:
      out.axis = .folded
    case .string("linear")?, nil:
      guard case .linear(let dc, let ddpp, _) = d.axis else { break }
      let c = finite(A["centerDay"]).map(JSNumber.round) ?? Double(dc)
      var dpp = ddpp
      if let v = finite(A["daysPerPx"]), v > 0 { dpp = v }
      out.axis = .linear(centerDay: Int(clamp(c, Double(minDay), Double(maxDay))),
                         daysPerPx: sig6(clamp(dpp, minDaysPerPx, maxDaysPerPx)), keepLinear: A["keepLinear"] == .bool(true))
    case let mode?:
      warnings.append("axis mode '\(Vocab.jsString(mode))' unknown; default axis used")
    }

    if case .string(let t)? = s["tier"], t == "auto" || JSString.includes(Vocab.tiers, t) { out.tier = t } else { out.tier = "auto" }

    let V = s["vantage"]?.objectValue ?? [:]
    out.vantage = Vantage(
      day: finite(V["day"]).map { Int(clamp(JSNumber.round($0), Double(minDay), Double(maxDay))) } ?? d.vantage.day,
      strict: V["strict"]?.boolValue ?? d.vantage.strict)

    if case .array(let r)? = s["range"], r.count == 2, let a0 = finite(r[0]), let b0 = finite(r[1]) {
      let a = Int(clamp(JSNumber.round(a0), Double(minDay), Double(maxDay)))
      let b = Int(clamp(JSNumber.round(b0), Double(minDay), Double(maxDay)))
      out.range = a <= b ? [a, b] : [b, a]
    }

    let E = s["evidence"]?.objectValue ?? [:]
    for k in evidenceKeys { out.evidence[k] = bit(E[k], d.evidence[k]!) }
    let Ly = s["layers"]?.objectValue ?? [:]
    for k in layerKeys { out.layers[k] = bit(Ly[k], d.layers[k]!) }

    if let sel = s["selection"]?.objectValue, let type = oneOf(sel["type"], Vocab.selectionTypes) {
      if type == "bin", let id = shortStr(sel["id"]) {
        out.selection = Selection(type: type, id: .string(id))
      } else if type != "bin", let id = posInt(sel["id"]) {
        out.selection = Selection(type: type, id: .number(id))
      } else {
        warnings.append("selection without a valid id ignored")
      }
    }

    let P = s["panels"]?.objectValue ?? [:]
    out.panels = Panels(inspector: P["inspector"] == .null ? nil : oneOf(P["inspector"], inspectorModes) ?? "tnn",
                        right: oneOf(P["right"], Vocab.rightPanels))

    if let c = s["compare"]?.objectValue {
      let a = canonSlice(c["a"], &warnings), b = canonSlice(c["b"], &warnings)
      if let a, let b { out.compare = Compare(a: a, b: b) } else { warnings.append("compare needs two slices with years; ignored") }
    }

    let K = s["constellation"]?.objectValue ?? [:]
    out.constellation = Constellation(
      layoutKey: K["layoutKey"] == .string("-") ? nil : shortStr(K["layoutKey"], max: 120),
      size: oneOf(K["size"], Vocab.constellationSizes) ?? "occurrences", a: canonYears(K["a"]), b: canonYears(K["b"]))

    let G = s["lineage"]?.objectValue ?? [:]
    var root: String? = nil
    if case .string(let r)? = G["root"], isLineageRoot(r) { root = shortStr(G["root"], max: 200) }
    let types = (G["types"]?.arrayValue ?? []).compactMap { $0.stringValue }.filter { Vocab.relTypeByCode.contains(key: $0) }
    let status = (G["status"]?.arrayValue ?? []).compactMap { $0.stringValue }.filter { JSString.includes(Vocab.evidenceStatus, $0) }
    out.lineage = Lineage(root: root, depth: safeInt(G["depth"]).map { clamp($0, 1, 6) } ?? 2,
                          types: uniqueInOrder(types).sorted(by: CanonicalJSON.codeUnitLess),
                          status: uniqueInOrder(status).sorted(by: CanonicalJSON.codeUnitLess))

    let R = s["runs"]?.objectValue ?? [:]
    var mat: [Int: Int] = [:]
    if let m = R["materialize"]?.objectValue {
      for k in jsPropertyOrder(m.keys) {
        if let e = posInt(.string(k)), let r = posInt(m[k]) { mat[e] = r }
      }
    }
    out.runs = Runs(materialize: mat, cluster: posInt(R["cluster"]), quotes: posInt(R["quotes"]), vectors: posInt(R["vectors"]))

    out.asSaved = s["asSaved"] == .bool(true)
    out.reducedMotion = oneOf(s["reducedMotion"], reducedMotionModes) ?? "system"
    return out
  }

  // MARK: Filters (§7): 'lang:en,fr;kind:book,song;coll:cipher-gutenberg;basis:-estimated;syn:1'

  /// `parseFilter(str, warnings)`: the `f` grammar into `Filters`; unknown keys and malformed values are skipped and
  /// reported.
  public static func parseFilter(_ str: String, warnings: inout [String]) -> Filters {
    var f = Filters()
    var lists: [String: [String]] = [:]
    for seg in JSString.split(str, ";") {
      if JSString.trim(seg).isEmpty { continue }
      let i = JSString.indexOf(seg, ":")
      let key = JSString.trim(i < 0 ? seg : JSString.slice(seg, 0, i))
      let vals = i < 0 ? [] : JSString.split(JSString.slice(seg, i + 1), ",").map(JSString.trim).filter { !$0.isEmpty }
      if !JSString.includes(Vocab.filterKeys, key) { warnings.append("unknown filter '\(key)' ignored"); continue }
      if key == "syn" {
        if vals.count == 1, vals[0] == "0" || vals[0] == "1" { f.syn = vals[0] == "0" ? 0 : 1 }
        else { warnings.append("filter syn must be 0 or 1; '\(vals.joined(separator: ","))' ignored") }
        continue
      }
      for v in vals {
        if isFilterValue(v) { lists[key, default: f[list: key]].append(v) } else { warnings.append("filter value '\(v)' for \(key) ignored") }
      }
    }
    var fv: JSONObject = ["syn": .number(Double(f.syn))]
    for (k, v) in lists { fv[k] = .array(v.map(JSONValue.string)) }
    return canonicalFilter(.object(fv), &warnings)
  }

  /// `formatFilter(f, {withDefaults})`: the `f` grammar in FILTER_KEYS order; empty lists are left out and `syn` only
  /// when it differs from 1 unless `withDefaults`.
  public static func formatFilter(_ f: Filters, withDefaults: Bool = false) -> String {
    var w: [String] = []
    let c = canonicalFilter(filtersJSON(f), &w)
    var parts: [String] = []
    for k in Vocab.filterKeys {
      if k == "syn" {
        if withDefaults || c.syn != 1 { parts.append("syn:\(c.syn)") }
        continue
      }
      let list = c[list: k]
      if !list.isEmpty { parts.append("\(k):\(list.joined(separator: ","))") }
    }
    return parts.joined(separator: ";")
  }

  static func filtersJSON(_ f: Filters) -> JSONValue {
    var o: JSONObject = ["syn": .number(Double(f.syn))]
    for k in Vocab.filterKeys where k != "syn" { o[k] = .array(f[list: k].map(JSONValue.string)) }
    return .object(o)
  }

  static func canonicalFilter(_ input: JSONValue?, _ warnings: inout [String]) -> Filters {
    var out = Filters()
    let src = input?.objectValue ?? [:]
    for k in Vocab.filterKeys {
      if k == "syn" {
        out.syn = src["syn"] == .number(0) || src["syn"] == .string("0") ? 0 : 1
        continue
      }
      let vals = src[k]?.arrayValue ?? []
      let keep = vals.map { JSString.trim(Vocab.jsString($0)) }.filter { v in
        if isFilterValue(v) { return true }
        warnings.append("filter value '\(v)' for \(k) ignored")
        return false
      }
      out[list: k] = uniqueInOrder(keep).sorted(by: CanonicalJSON.codeUnitLess)
    }
    return out
  }

  /// `VALUE_RE = /^-?[^,;:\s][^,;:]{0,119}$/u` (lengths in code points).
  static func isFilterValue(_ v: String) -> Bool {
    let cps = Array(v.unicodeScalars).map(\.value)
    func separator(_ c: UInt32) -> Bool { c == 0x2C || c == 0x3B || c == 0x3A }
    func first(_ c: UInt32) -> Bool { !separator(c) && !(c <= 0xFFFF && JSString.isWhitespace(UInt16(c))) }
    func tail(_ from: Int) -> Bool { cps.count - from <= 119 && !cps[from...].contains(where: separator) }
    guard let c0 = cps.first else { return false }
    if first(c0) && tail(1) { return true }
    return c0 == 0x2D && cps.count >= 2 && first(cps[1]) && tail(2)
  }

  // MARK: Pieces

  static func canonStrands(_ input: JSONValue?, _ warnings: inout [String]) -> [Strand] {
    var out: [Strand] = []
    var seen = Set<CodeUnitKey>()
    for s in input?.arrayValue ?? [] {
      guard let o = s.objectValue, let type = oneOf(o["type"], Vocab.strandTypes) else {
        warnings.append("strand with an unknown type ignored")
        continue
      }
      let id: StrandID
      if numericStrands.contains(type) {
        guard let n = posInt(o["id"]) else { warnings.append("strand \(type) without a valid id ignored"); continue }
        id = .number(n)
      } else {
        guard let t = shortStr(o["id"]) else { warnings.append("strand \(type) without a valid id ignored"); continue }
        id = .string(t)
      }
      let key: String = switch id {
      case .number(let n): "\(type):\(n)"
      case .string(let t): "\(type):\(t)"
      }
      if seen.contains(CodeUnitKey(key)) { continue }
      if out.count == maxStrands { warnings.append("more than \(maxStrands) strands; extra strands ignored"); break }
      seen.insert(CodeUnitKey(key))
      var variants = Variants.default
      if type == "expression" {
        if case .array(let list)? = o["variants"] {
          var ids: [Int] = []
          for v in list { if let n = posInt(v), !ids.contains(n) { ids.append(n) } }
          variants = ids.isEmpty ? .default : .ids(ids.sorted())
        } else {
          switch oneOf(o["variants"], variantModes) {
          case "identity": variants = .identity
          case "all": variants = .all
          default: variants = .default
          }
        }
      }
      out.append(Strand(type: type, id: id, variants: variants, glyph: Vocab.strandGlyphs[out.count]))
    }
    return out
  }

  static func canonYears(_ x: JSONValue?) -> [Int]? {
    guard case .array(let a)? = x, a.count == 2, let y0 = jsInt(a[0]), let y1 = jsInt(a[1]) else { return nil }
    let a0 = clamp(y0, -9999, 2100), b0 = clamp(y1, -9999, 2100)  // the pan domain, 10000 BCE – 2100 CE
    return a0 <= b0 ? [a0, b0] : [b0, a0]
  }

  static func canonSlice(_ x: JSONValue?, _ warnings: inout [String]) -> Slice? {
    guard let o = x?.objectValue, let years = canonYears(o["years"]) else { return nil }
    let text = o["f"]?.stringValue ?? ""
    return Slice(years: years, f: formatFilter(parseFilter(text, warnings: &warnings)))
  }

  // MARK: JavaScript coercions

  static func isCorpusSlug(_ s: String) -> Bool {  // /^[a-z0-9][a-z0-9_-]{0,47}$/
    let u = Array(s.utf16)
    func lowerDigit(_ c: UInt16) -> Bool { (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) }
    guard let c0 = u.first, lowerDigit(c0), u.count <= 48 else { return false }
    return u.dropFirst().allSatisfy { lowerDigit($0) || $0 == 0x5F || $0 == 0x2D }
  }

  static func isLineageRoot(_ s: String) -> Bool {  // /^[a-z_]+:./
    let u = Array(s.utf16)
    var i = 0
    while i < u.count, (u[i] >= 0x61 && u[i] <= 0x7A) || u[i] == 0x5F { i += 1 }
    guard i > 0, i + 1 < u.count, u[i] == 0x3A else { return false }
    return ![0x0A, 0x0D, 0x2028, 0x2029].contains(u[i + 1])
  }

  /// `oneOf(x, list, dflt)` without the default: x when it is a string in `list` (code-unit equality).
  static func oneOf(_ x: JSONValue?, _ list: [String]) -> String? {
    guard case .string(let s)? = x, JSString.includes(list, s) else { return nil }
    return s
  }

  /// `bit(x, dflt)`: 0/1, true/false and '1'/'0' are bits; anything else is the default.
  static func bit(_ x: JSONValue?, _ dflt: Int) -> Int {
    switch x {
    case .number(0)?: 0
    case .number(1)?: 1
    case .bool(true)?: 1
    case .bool(false)?: 0
    case .string("1")?: 1
    case .string("0")?: 0
    default: dflt
    }
  }

  /// `posInt(x)`: a positive safe integer, or a string of 1–15 digits naming one; else nil.
  static func posInt(_ x: JSONValue?) -> Int? {
    switch x {
    case .number(let n)?: return JSNumber.isSafeInteger(n) && n > 0 ? Int(n) : nil
    case .string(let s)?:
      guard (1...15).contains(s.utf16.count), s.utf16.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), let n = Int(s), n > 0 else { return nil }
      return n
    default: return nil
    }
  }

  /// `int(x)`: a safe integer, or a string matching /^-?\d{1,15}$/; else nil.
  static func jsInt(_ x: JSONValue?) -> Int? {
    switch x {
    case .number(let n)?: return JSNumber.isSafeInteger(n) ? Int(n) : nil
    case .string(let s)?:
      var u = Array(s.utf16)[...]
      if u.first == 0x2D { u = u.dropFirst() }
      guard (1...15).contains(u.count), u.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return nil }
      return Int(s)
    default: return nil
    }
  }

  static func safeInt(_ x: JSONValue?) -> Int? {
    guard case .number(let n)? = x, JSNumber.isSafeInteger(n) else { return nil }
    return Int(n)
  }

  static func finite(_ x: JSONValue?) -> Double? {
    guard case .number(let n)? = x, n.isFinite else { return nil }
    return n
  }

  /// `shortStr(x, max)`: a non-empty string of at most `max` UTF-16 units with no C0 control character.
  static func shortStr(_ x: JSONValue?, max: Int = 200) -> String? {
    guard case .string(let s)? = x, !s.isEmpty, s.utf16.count <= max, !s.utf16.contains(where: { $0 < 0x20 }) else { return nil }
    return s
  }

  static func clamp<T: Comparable>(_ x: T, _ lo: T, _ hi: T) -> T { min(hi, max(lo, x)) }

  /// `Number(Number(x).toPrecision(6))`.
  static func sig6(_ x: Double) -> Double { Double(JSNumber.toPrecision(x, 6))! }

  /// `[...new Set(list)]`: first occurrences in order, by code units.
  static func uniqueInOrder(_ list: [String]) -> [String] {
    var seen = Set<CodeUnitKey>()
    return list.filter { seen.insert(CodeUnitKey($0)).inserted }
  }

  /// The order `Object.entries` visits an object's own string keys: array indices ascending, then the other keys.
  /// A JSONValue object has no insertion order, so the other keys follow in code-unit order.
  static func jsPropertyOrder<S: Sequence>(_ keys: S) -> [String] where S.Element == String {
    func arrayIndex(_ k: String) -> UInt32? {
      let u = Array(k.utf16)
      guard !u.isEmpty, u.count <= 10, u.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), u.count == 1 || u[0] != 0x30,
        let n = UInt64(k), n < 4_294_967_295 else { return nil }
      return UInt32(n)
    }
    let all = Array(keys)
    let indices = all.compactMap { k in arrayIndex(k).map { (k, $0) } }.sorted { $0.1 < $1.1 }.map(\.0)
    let others = all.filter { arrayIndex($0) == nil }.sorted(by: CanonicalJSON.codeUnitLess)
    return indices + others
  }
}
