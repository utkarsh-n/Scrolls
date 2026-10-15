// OWNER: N0
// The URL hash of src/shared/viewstate.mjs (SPEC §8.2): `encode` writes a readable, versioned, canonical hash with
// defaults omitted; `decodeHash` validates, fills defaults and never fails. encodeURIComponent/decodeURIComponent are
// reproduced exactly (UTF-8, uppercase hex, URIError on malformed escapes).

/// A saved view named by a hash (`#view=<slug>&as=1`), which the caller resolves through the views API.
public struct SavedViewReference: Sendable, Equatable {
  public var slug: String
  public var asSaved: Bool
  public init(slug: String, asSaved: Bool) {
    self.slug = slug
    self.asSaved = asSaved
  }
}

/// `ViewState(hash:)` met a saved-view hash: the state must be read from the saved view itself.
public struct ViewStateNeedsSavedView: Error, Sendable, Equatable {
  public let view: SavedViewReference
  /// The corpus default state the reference returns alongside the reference.
  public let defaultState: ViewState
}

extension ViewState {
  /// `decodeHash(hash).state` for a hash that holds a state. A saved-view hash throws `ViewStateNeedsSavedView`
  /// (the reference returns the corpus default plus the view reference); every other hash decodes, with repairs.
  public init(hash: String) throws(ViewStateNeedsSavedView) {
    let r = ViewState.decodeHash(hash)
    if let view = r.view { throw ViewStateNeedsSavedView(view: view, defaultState: r.state) }
    self = r.state
  }

  /// `encode(state)`: the URL hash of this state (canonicalized first).
  public var hash: String { ViewState.encode(self) }

  /// `encode(state)`.
  public static func encode(_ state: ViewState) -> String {
    let s = state.canonicalized()
    let d = defaultState(s.corpus)
    var p = ["v=\(version)", "c=\(s.corpus)"]

    if !s.strands.isEmpty {
      p.append("s=" + s.strands.map { x in
        var t = strandCodes[x.type]!
        switch x.id {
        case .number(let n): t += String(n)
        case .string(let id): t += encAtom(id)
        }
        switch x.variants {
        case .ids(let ids): t += "-v" + ids.map(String.init).joined(separator: "_")
        case .identity: t += "-i"
        case .all: t += "-a"
        case .default: break
        }
        return t
      }.joined(separator: ","))
    }
    let L = s.lanes
    if L.facet != d.lanes.facet || L.sub != nil || L.run != nil || L.order != d.lanes.order || L.max != d.lanes.max {
      var l = "\(L.facet)\(L.sub.map { "/\($0)" } ?? ""):\(orderCodes[L.order]!)"
      if let run = L.run { l += ":r\(run)" }
      if L.max != d.lanes.max { l += ":m\(L.max)" }
      p.append("l=\(l)")
    }
    if !L.manual.isEmpty { p.append("lm=" + L.manual.map(encText).joined(separator: "~")) }
    if s.f != d.f { p.append("f=" + encText(formatFilter(s.f, withDefaults: s.f.syn != 1))) }
    let tg = Vocab.toggleDefaults.filter { s.toggles[$0.key] != $0.value }.map { "\($0.key)\(s.toggles[$0.key]!)" }
    if !tg.isEmpty { p.append("tg=" + tg.joined(separator: ".")) }
    if s.timeBasis != "publication" { p.append("tb=ref") }
    if s.axis != d.axis {
      switch s.axis {
      case .folded: p.append("x=fold")
      case .linear(let c, let dpp, let k): p.append("x=lin:\(c):\(JSNumber.format(dpp))\(k ? ":k" : "")")
      }
    }
    if s.tier != "auto" { p.append("ti=\(s.tier)") }
    if s.vantage != d.vantage { p.append("t=\(s.vantage.day)\(s.vantage.strict ? "s" : "c")") }
    if let r = s.range { p.append("rg=\(r[0]):\(r[1])") }
    if s.evidence != d.evidence { p.append("ev=" + letters(s.evidence, evidenceKeys, evidenceLetters)) }
    if s.layers != d.layers { p.append("ly=" + letters(s.layers, layerKeys, layerLetters)) }
    if let sel = s.selection {
      let id: String = switch sel.id {
      case .number(let n): String(n)
      case .string(let t): t
      }
      p.append("sel=\(selectionCodes[sel.type]!):\(encAtom(id))")
    }
    if s.panels != d.panels { p.append("p=\(s.panels.inspector ?? "-")\(s.panels.right.map { ",\($0)" } ?? "")") }
    if let c = s.compare {
      func sl(_ x: Slice) -> String { "\(x.years[0])-\(x.years[1])\(x.f.isEmpty ? "" : "@" + encText(x.f))" }
      p.append("cmp=\(sl(c.a))~\(sl(c.b))")
    }
    let K = s.constellation
    if K != d.constellation {
      func yr(_ y: [Int]?) -> String { y.map { "\($0[0])-\($0[1])" } ?? "-" }
      p.append("k=\(K.layoutKey.map(encText) ?? "-")~\(sizeCodes[K.size]!)~\(yr(K.a))~\(yr(K.b))")
    }
    let G = s.lineage
    if G != d.lineage {
      p.append("lg=\(G.root.map(encText) ?? "-")~\(G.depth)~\(G.types.joined(separator: ","))~\(G.status.joined(separator: ","))")
    }
    if s.runs != d.runs {
      var r = s.runs.materialize.keys.sorted().map { "m\($0)_\(s.runs.materialize[$0]!)" }
      if let c = s.runs.cluster { r.append("c\(c)") }
      if let q = s.runs.quotes { r.append("q\(q)") }
      if let v = s.runs.vectors { r.append("v\(v)") }
      p.append("r=" + r.joined(separator: "."))
    }
    if s.asSaved { p.append("as=1") }
    // reduced motion is the viewer's own setting: it never travels in a link
    return "#" + p.joined(separator: "&")
  }

  /// `decodeHash(hash)`: the canonical state and what was repaired. A saved-view hash returns the corpus default state
  /// plus `view`.
  public static func decodeHash(_ hash: String) -> (state: ViewState, warnings: [String], view: SavedViewReference?) {
    var warnings: [String] = []
    let params = splitParams(hash)
    if let view = params.value("view") {
      let slug = decodeURIComponent(view, &warnings) ?? ""
      let state = canonicalize(["corpus": .string(params.value("c") ?? "demo")], warnings: &warnings)
      return (state, warnings, slug.isEmpty ? nil : SavedViewReference(slug: slug, asSaved: params.value("as") == "1"))
    }
    if params.isEmpty { return (defaultState("demo"), warnings, nil) }
    if let v = params.value("v") {
      if v != String(version) { warnings.append("hash version \(v) is not \(version); read as v1") }
    } else {
      warnings.append("hash has no version; read as v1")
    }
    guard case .object(var st) = defaultState(params.value("c") ?? "demo").jsonValue else { preconditionFailure() }
    for (key, raw) in params.pairs where key != "v" && key != "c" {
      if !applyParam(&st, key, raw, &warnings) { warnings.append("parameter \(key)='\(raw)' not understood; default kept") }
    }
    return (canonicalize(.object(st), warnings: &warnings), warnings, nil)
  }

  // MARK: Parameters

  /// The hash's parameters with JavaScript Map semantics: a repeated key keeps its first position and its last value.
  struct Params {
    var pairs: [(String, String)] = []
    var isEmpty: Bool { pairs.isEmpty }
    func value(_ key: String) -> String? { pairs.first { JSString.equal($0.0, key) }?.1 }
    mutating func set(_ key: String, _ value: String) {
      if let i = pairs.firstIndex(where: { JSString.equal($0.0, key) }) { pairs[i].1 = value } else { pairs.append((key, value)) }
    }
  }

  static func splitParams(_ hash: String) -> Params {
    var params = Params()
    let h = JSString.hasPrefix(hash, "#") ? JSString.slice(hash, 1) : hash
    for part in JSString.split(h, "&") where !part.isEmpty {
      let i = JSString.indexOf(part, "=")
      params.set(i < 0 ? part : JSString.slice(part, 0, i), i < 0 ? "" : JSString.slice(part, i + 1))
    }
    return params
  }

  /// `applyParam(st, key, raw, w)` on the loose state object; false when the value was not understood.
  static func applyParam(_ st: inout JSONObject, _ key: String, _ raw: String, _ w: inout [String]) -> Bool {
    func member(_ k: String) -> JSONObject { st[k]?.objectValue ?? [:] }
    switch key {
    case "s":
      var strands: [JSONValue] = []
      for tok in JSString.split(raw, ",") where !tok.isEmpty {
        let code = JSString.slice(tok, 0, 1)
        guard let type = strandByCode[code] else { w.append("strand '\(tok)' ignored"); continue }
        if numericStrands.contains(type) {
          guard let m = matchNumericStrand(tok) else { w.append("strand '\(tok)' ignored"); continue }
          let variants: JSONValue
          switch m.variants {
          case nil: variants = "default"
          case "i"?: variants = "identity"
          case "a"?: variants = "all"
          case let v?:
            variants = .array(JSString.split(JSString.slice(v, 1), "_").filter { !$0.isEmpty }.map { .number(JSNumber.parse($0)) })
          }
          strands.append(["type": .string(type), "id": .number(JSNumber.parse(m.id)), "variants": variants])
        } else {
          let id = decodeURIComponent(JSString.slice(tok, 1), &w)
          strands.append(["type": .string(type), "id": id.map(JSONValue.string) ?? .null])
        }
      }
      st["strands"] = .array(strands)
      return true
    case "l":
      guard let m = matchLanes(raw) else { return false }
      var lanes = member("lanes")
      lanes["facet"] = .string(m.facet)
      lanes["sub"] = m.sub.map(JSONValue.string) ?? .null
      lanes["order"] = .string(orderByCode[m.order] ?? "first_observed")
      for opt in m.options {
        let n = JSONValue.number(JSNumber.parse(JSString.slice(opt, 1)))
        if JSString.hasPrefix(opt, "r") { lanes["run"] = n } else { lanes["max"] = n }
      }
      st["lanes"] = .object(lanes)
      return true
    case "lm":
      var lanes = member("lanes")
      lanes["manual"] = .array(JSString.split(raw, "~").compactMap { decodeURIComponent($0, &w) }.filter { !$0.isEmpty }.map(JSONValue.string))
      st["lanes"] = .object(lanes)
      return true
    case "f":
      guard let txt = decodeURIComponent(raw, &w) else { return false }
      st["f"] = filtersJSON(parseFilter(txt, warnings: &w))
      return true
    case "tg":
      var toggles = member("toggles")
      for t in JSString.split(raw, ".") {
        let u = Array(t.utf16)
        let name = u.dropLast()
        if u.count >= 2, u.last == 0x30 || u.last == 0x31, name.allSatisfy({ $0 >= 0x61 && $0 <= 0x7A }),
          Vocab.toggleDefaults.contains(key: String(decoding: name, as: UTF16.self)) {
          toggles[String(decoding: name, as: UTF16.self)] = .number(u.last == 0x31 ? 1 : 0)
        } else {
          w.append("toggle '\(t)' ignored")
        }
      }
      st["toggles"] = .object(toggles)
      return true
    case "tb":
      st["timeBasis"] = raw == "ref" ? "referenced" : "publication"
      return raw == "ref" || raw == "pub"
    case "x":
      if raw == "fold" { st["axis"] = ["mode": "folded"]; return true }
      guard let m = matchLinearAxis(raw) else { return false }
      st["axis"] = ["mode": "linear", "centerDay": .number(JSNumber.parse(m.center)), "daysPerPx": .number(JSNumber.parse(m.dpp)),
                    "keepLinear": .bool(m.keep)]
      return true
    case "ti":
      st["tier"] = .string(raw)
      return JSString.includes(Vocab.tiers, raw) || raw == "auto"
    case "t":
      let u = Array(raw.utf16)
      guard let last = u.last, last == 0x73 || last == 0x63, isSignedDigits(u.dropLast(), max: 15) else { return false }
      st["vantage"] = ["day": .number(JSNumber.parse(String(decoding: u.dropLast(), as: UTF16.self))), "strict": .bool(last == 0x73)]
      return true
    case "rg":
      let parts = JSString.split(raw, ":")
      guard parts.count == 2, isSignedDigits(parts[0].utf16[...], max: 15), isSignedDigits(parts[1].utf16[...], max: 15) else { return false }
      st["range"] = [.number(JSNumber.parse(parts[0])), .number(JSNumber.parse(parts[1]))]
      return true
    case "ev", "ly":
      let (keys, codes) = key == "ev" ? (evidenceKeys, evidenceLetters) : (layerKeys, layerLetters)
      guard raw == "0" || (!raw.isEmpty && raw.utf16.allSatisfy { $0 >= 0x61 && $0 <= 0x7A }) else { return false }
      var obj: JSONObject = [:]
      for (k, c) in zip(keys, codes) { obj[k] = .number(JSString.indexOf(raw, c) >= 0 ? 1 : 0) }
      st[key == "ev" ? "evidence" : "layers"] = .object(obj)
      return true
    case "sel":
      let i = JSString.indexOf(raw, ":")
      guard i >= 0, let type = selectionByCode[JSString.slice(raw, 0, i)] else { return false }
      let id = decodeURIComponent(JSString.slice(raw, i + 1), &w)
      let idValue: JSONValue = type == "bin" ? (id.map(JSONValue.string) ?? .null) : .number(id.map(JSNumber.parse) ?? 0)
      st["selection"] = ["type": .string(type), "id": idValue]
      return true
    case "p":
      let parts = JSString.split(raw, ",")
      st["panels"] = ["inspector": parts[0] == "-" ? .null : .string(parts[0]), "right": parts.count > 1 ? .string(parts[1]) : .null]
      return true
    case "cmp":
      let slices: [JSONValue?] = JSString.split(raw, "~").map { part in
        guard let m = matchCompareSlice(part) else { return nil }
        let f = m.f.flatMap { $0.isEmpty ? nil : (decodeURIComponent($0, &w) ?? "") } ?? ""
        return ["years": [.number(JSNumber.parse(m.lo)), .number(JSNumber.parse(m.hi))], "f": .string(f)]
      }
      guard slices.count == 2, let a = slices[0], let b = slices[1] else { return false }
      st["compare"] = ["a": a, "b": b]
      return true
    case "k":
      let parts = JSString.split(raw, "~")
      func part(_ i: Int) -> String? { i < parts.count ? parts[i] : nil }
      func yr(_ y: String?) -> JSONValue {
        guard let pair = matchYearPair(y ?? "") else { return .null }  // YEAR_PAIR
        return [.number(JSNumber.parse(pair.0)), .number(JSNumber.parse(pair.1))]
      }
      let lk = part(0)
      st["constellation"] = [
        "layoutKey": lk.flatMap { $0.isEmpty || $0 == "-" ? nil : decodeURIComponent($0, &w) }.map(JSONValue.string) ?? .null,
        "size": .string(part(1).flatMap { sizeByCode[$0] } ?? "occurrences"), "a": yr(part(2)), "b": yr(part(3)),
      ]
      return true
    case "lg":
      let parts = JSString.split(raw, "~")
      func part(_ i: Int) -> String? { i < parts.count ? parts[i] : nil }
      let root = part(0).flatMap { $0.isEmpty || $0 == "-" ? nil : decodeURIComponent($0, &w) }
      let depth = part(1).map(JSNumber.parse) ?? .nan
      st["lineage"] = [
        "root": root.map(JSONValue.string) ?? .null,
        "depth": .number(depth.isNaN || depth == 0 ? 2 : depth),
        "types": .array((part(2).flatMap { $0.isEmpty ? nil : JSString.split($0, ",") } ?? []).map(JSONValue.string)),
        "status": .array((part(3).flatMap { $0.isEmpty ? nil : JSString.split($0, ",") } ?? []).map(JSONValue.string)),
      ]
      return true
    case "r":
      var materialize: JSONObject = [:]
      var runs: JSONObject = ["cluster": .null, "quotes": .null, "vectors": .null]
      for t in JSString.split(raw, ".") {
        let u = Array(t.utf16)
        if u.first == 0x6D, let us = u.firstIndex(of: 0x5F), isDigits(u[1..<us], max: 15), isDigits(u[(us + 1)...], max: 15) {
          materialize[String(decoding: u[1..<us], as: UTF16.self)] = .number(JSNumber.parse(String(decoding: u[(us + 1)...], as: UTF16.self)))
        } else if let c = u.first, c == 0x63 || c == 0x71 || c == 0x76, isDigits(u.dropFirst(), max: 15) {
          runs[c == 0x63 ? "cluster" : c == 0x71 ? "quotes" : "vectors"] = .number(JSNumber.parse(String(decoding: u.dropFirst(), as: UTF16.self)))
        } else {
          w.append("run '\(t)' ignored")
        }
      }
      runs["materialize"] = .object(materialize)
      st["runs"] = .object(runs)
      return true
    case "as":
      st["asSaved"] = .bool(raw == "1")
      return raw == "1" || raw == "0"
    case "rm":
      // links made before the reference's fix pass carried rm=; the viewer's own setting wins, so it is ignored
      return true
    default:
      w.append("unknown parameter '\(key)' ignored")
      return true
    }
  }

  // MARK: Grammar matchers (the reference's regular expressions, written out)

  static func isDigits<C: Collection>(_ u: C, max: Int) -> Bool where C.Element == UInt16 {
    (1...max).contains(u.count) && u.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
  }

  static func isSignedDigits<C: Collection>(_ u: C, max: Int) -> Bool where C.Element == UInt16 {
    u.first == 0x2D ? isDigits(u.dropFirst(), max: max) : isDigits(u, max: max)
  }

  /// `/^.(\d{1,15})(?:-(i|a|v[\d_]+))?$/` (the first code unit is the strand code).
  static func matchNumericStrand(_ tok: String) -> (id: String, variants: String?)? {
    let u = Array(tok.utf16)
    guard u.count >= 2 else { return nil }
    var j = 1
    while j < u.count, u[j] >= 0x30 && u[j] <= 0x39 { j += 1 }
    let id = u[1..<j]
    guard isDigits(id, max: 15) else { return nil }
    if j == u.count { return (String(decoding: id, as: UTF16.self), nil) }
    guard u[j] == 0x2D, j + 1 < u.count else { return nil }
    let v = u[(j + 1)...]
    let ok = v.elementsEqual([0x69]) || v.elementsEqual([0x61])
      || (v.first == 0x76 && v.count >= 2 && v.dropFirst().allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x5F })
    return ok ? (String(decoding: id, as: UTF16.self), String(decoding: v, as: UTF16.self)) : nil
  }

  /// `/^([a-z_]+)(?:\/([a-z_]+))?:([a-z]{2})((?::[rm]\d{1,15})*)$/`.
  static func matchLanes(_ raw: String) -> (facet: String, sub: String?, order: String, options: [String])? {
    let u = Array(raw.utf16)
    func word(_ c: UInt16) -> Bool { (c >= 0x61 && c <= 0x7A) || c == 0x5F }
    var i = 0
    while i < u.count, word(u[i]) { i += 1 }
    guard i > 0 else { return nil }
    let facet = String(decoding: u[0..<i], as: UTF16.self)
    var sub: String? = nil
    if i < u.count, u[i] == 0x2F {
      var j = i + 1
      while j < u.count, word(u[j]) { j += 1 }
      guard j > i + 1 else { return nil }
      sub = String(decoding: u[(i + 1)..<j], as: UTF16.self)
      i = j
    }
    guard i + 3 <= u.count, u[i] == 0x3A, u[(i + 1)...(i + 2)].allSatisfy({ $0 >= 0x61 && $0 <= 0x7A }) else { return nil }
    let order = String(decoding: u[(i + 1)...(i + 2)], as: UTF16.self)
    let rest = String(decoding: u[(i + 3)...], as: UTF16.self)
    var options: [String] = []
    if !rest.isEmpty {
      let pieces = JSString.split(rest, ":")
      guard pieces.first == "" else { return nil }
      for piece in pieces.dropFirst() {
        let p = Array(piece.utf16)
        guard let c = p.first, c == 0x72 || c == 0x6D, isDigits(p.dropFirst(), max: 15) else { return nil }
        options.append(piece)
      }
    }
    return (facet, sub, order, options)
  }

  /// `/^lin:(-?\d{1,15}):(\d+(?:\.\d+)?(?:e-?\d+)?)(:k)?$/`.
  static func matchLinearAxis(_ raw: String) -> (center: String, dpp: String, keep: Bool)? {
    guard JSString.hasPrefix(raw, "lin:") else { return nil }
    var parts = JSString.split(JSString.slice(raw, 4), ":")
    var keep = false
    if parts.count == 3, parts[2] == "k" { keep = true; parts.removeLast() }
    guard parts.count == 2, isSignedDigits(parts[0].utf16[...], max: 15) else { return nil }
    let d = Array(parts[1].utf16)
    var i = 0
    func digitsRun() -> Int { let s = i; while i < d.count, d[i] >= 0x30 && d[i] <= 0x39 { i += 1 }; return i - s }
    guard digitsRun() > 0 else { return nil }
    if i < d.count, d[i] == 0x2E { i += 1; guard digitsRun() > 0 else { return nil } }
    if i < d.count, d[i] == 0x65 {
      i += 1
      if i < d.count, d[i] == 0x2D { i += 1 }
      guard digitsRun() > 0 else { return nil }
    }
    guard i == d.count else { return nil }
    return (parts[0], parts[1], keep)
  }

  /// `/^(-?\d{1,6})-(-?\d{1,6})(?:@(.*))?$/` (`.` stops at line terminators).
  static func matchCompareSlice(_ part: String) -> (lo: String, hi: String, f: String?)? {
    let at = JSString.indexOf(part, "@")
    let years = at < 0 ? part : JSString.slice(part, 0, at)
    let f: String? = at < 0 ? nil : JSString.slice(part, at + 1)
    if let f, f.utf16.contains(where: { [0x0A, 0x0D, 0x2028, 0x2029].contains($0) }) { return nil }
    guard let pair = matchYearPair(years) else { return nil }
    return (pair.0, pair.1, f)
  }

  /// `/^(-?\d{1,6})-(-?\d{1,6})$/`.
  static func matchYearPair(_ s: String) -> (String, String)? {
    let u = Array(s.utf16)
    let start = u.first == 0x2D ? 1 : 0
    var i = start
    while i < u.count, u[i] >= 0x30 && u[i] <= 0x39 { i += 1 }
    guard i - start >= 1, i - start <= 6, i < u.count, u[i] == 0x2D else { return nil }
    let lo = String(decoding: u[0..<i], as: UTF16.self)
    let rest = u[(i + 1)...]
    guard isSignedDigits(rest, max: 6) else { return nil }
    return (lo, String(decoding: rest, as: UTF16.self))
  }

  // MARK: Codes

  static let orderCodes = ["first_observed": "fo", "total_n": "tn", "alphabetical": "al", "manual": "mn"]
  static let strandCodes = ["expression": "e", "theme": "t", "work": "w", "maker": "m", "cluster": "k", "baseline": "b"]
  static let selectionCodes = ["occurrence": "occ", "passage": "psg", "cluster": "cl", "relationship": "rel", "document": "doc", "bin": "bin"]
  static let sizeCodes = ["occurrences": "o", "documents": "d", "authors": "a"]
  static let orderByCode = Dictionary(uniqueKeysWithValues: orderCodes.map { ($1, $0) })
  static let strandByCode = Dictionary(uniqueKeysWithValues: strandCodes.map { ($1, $0) })
  static let selectionByCode = Dictionary(uniqueKeysWithValues: selectionCodes.map { ($1, $0) })
  static let sizeByCode = Dictionary(uniqueKeysWithValues: sizeCodes.map { ($1, $0) })

  static func letters(_ obj: [String: Int], _ keys: [String], _ codes: [String]) -> String {
    let s = zip(keys, codes).map { (obj[$0.0] ?? 0) != 0 ? $0.1 : "" }.joined()
    return s.isEmpty ? "0" : s
  }

  // MARK: URI components

  /// The strict atom encoding: everything but [A-Za-z0-9_-] is escaped (encodeURIComponent, then ~!'()*. too).
  static func encAtom(_ s: String) -> String { percentEncode(s) { isAlnum($0) || $0 == 0x2D || $0 == 0x5F } }

  /// The readable encoding of grammar strings: encodeURIComponent's unreserved set plus ':' ',' ';' '/' '@', '~' escaped.
  static func encText(_ s: String) -> String {
    percentEncode(s) { c in
      isAlnum(c) || [0x2D, 0x5F, 0x2E, 0x21, 0x2A, 0x27, 0x28, 0x29, 0x3A, 0x2C, 0x3B, 0x2F, 0x40].contains(c)
    }
  }

  private static func isAlnum(_ c: UInt8) -> Bool { (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) }

  private static func percentEncode(_ s: String, keep: (UInt8) -> Bool) -> String {
    let hex = Array("0123456789ABCDEF".utf8)
    var out: [UInt8] = []
    for b in s.utf8 {
      if b < 0x80 && keep(b) { out.append(b) } else { out += [0x25, hex[Int(b >> 4)], hex[Int(b & 15)]] }
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// `dec(x, warnings)`: decodeURIComponent, or nil plus "undecodable value '…' ignored" on a URIError.
  static func decodeURIComponent(_ x: String, _ warnings: inout [String]) -> String? {
    if let s = decodeURIComponentStrict(x) { return s }
    warnings.append("undecodable value '\(x)' ignored")
    return nil
  }

  /// ECMA-262 decodeURIComponent: every %XX escape decoded; malformed escapes or invalid UTF-8 (overlong forms,
  /// surrogates, > U+10FFFF) fail.
  static func decodeURIComponentStrict(_ x: String) -> String? {
    let u = Array(x.utf16)
    var out: [UInt16] = []
    out.reserveCapacity(u.count)
    func hexValue(_ c: UInt16) -> UInt8? {
      switch c {
      case 0x30...0x39: UInt8(c - 0x30)
      case 0x41...0x46: UInt8(c - 0x41 + 10)
      case 0x61...0x66: UInt8(c - 0x61 + 10)
      default: nil
      }
    }
    func byte(at k: Int) -> UInt8? {
      guard k + 2 < u.count, u[k] == 0x25, let h = hexValue(u[k + 1]), let l = hexValue(u[k + 2]) else { return nil }
      return h << 4 | l
    }
    var k = 0
    while k < u.count {
      guard u[k] == 0x25 else { out.append(u[k]); k += 1; continue }
      guard let b0 = byte(at: k) else { return nil }
      k += 3
      if b0 < 0x80 { out.append(UInt16(b0)); continue }
      let n: Int, initial: UInt32
      switch b0 {
      case 0xC0...0xDF: n = 2; initial = UInt32(b0 & 0x1F)
      case 0xE0...0xEF: n = 3; initial = UInt32(b0 & 0x0F)
      case 0xF0...0xF7: n = 4; initial = UInt32(b0 & 0x07)
      default: return nil
      }
      var cp = initial
      for _ in 1..<n {
        guard let b = byte(at: k), b & 0xC0 == 0x80 else { return nil }
        cp = cp << 6 | UInt32(b & 0x3F)
        k += 3
      }
      let minimum: UInt32 = n == 2 ? 0x80 : n == 3 ? 0x800 : 0x10000
      guard cp >= minimum, cp <= 0x10FFFF, !(0xD800...0xDFFF).contains(cp) else { return nil }
      if cp >= 0x10000 {
        let v = cp - 0x10000
        out += [UInt16(0xD800 + (v >> 10)), UInt16(0xDC00 + (v & 0x3FF))]
      } else {
        out.append(UInt16(cp))
      }
    }
    return String(decoding: out, as: UTF16.self)
  }
}
