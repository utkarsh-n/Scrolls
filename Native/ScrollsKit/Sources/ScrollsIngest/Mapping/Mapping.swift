// OWNER: N1
// Port of server/ingest/mapping.mjs (SPEC §5.2): field mapping and the closed transform list — one source record → one
// CanonicalDocument (§12.3) plus the relationships it states. Everything unmapped stays in original_meta. Dates are
// parsed here (not by DocumentWriter) so that the dry run and the commit report the same issues with the same words: a
// date that does not parse is handed to the writer as an explicit 'unparsed' assertion (raw kept, undated), and its
// issue is recorded by the pipeline. Values are JavaScript values (`JSValue?`, nil = undefined), because the reference's
// rules turn on `typeof`, blank checks and `String(x)`.

import Foundation
import ScrollsContracts
import ScrollsCore

/// One transform of the closed list (§5.2).
public enum Transform: Sendable {
  case trim, lower, zeroIsUnknown
  case split(String)
  case join(String)
  case date(JSObject)
  case map(JSObject)
  case regexExtract(pattern: String, group: JSValue)

  public var op: String {
    switch self {
    case .trim: "trim"
    case .lower: "lower"
    case .zeroIsUnknown: "zero_is_unknown"
    case .split: "split"
    case .join: "join"
    case .date: "date"
    case .map: "map"
    case .regexExtract: "regex_extract"
    }
  }
}

/// A mapped target: `{from}` (a column name, a 1-based column number or a JSON Pointer) or `{const}`, its transforms
/// and the suggestion's reason.
public struct FieldSpec: Sendable {
  public var from: JSValue?
  /// `const` as written (`.null` is a constant null; nil means no constant).
  public var constValue: JSValue?
  public var transforms: [Transform]
  public var reason: String?
  /// The spec object as given (stored without the parsed transforms).
  public var raw: JSObject
}

/// A normalized mapping (`normalizeMapping(raw).mapping`).
public struct Mapping: Sendable {
  /// The normalized object (options and collection filled), in the reference's key order; fields as given.
  public var object: JSObject
  public var format: String
  public var fields: [(target: String, spec: FieldSpec)]
  public var dedupe: String
  public var detectLanguage: Bool
  public var onBadRow: String
  public var lineMode: Bool

  public func field(_ target: String) -> FieldSpec? { fields.first { $0.target == target }?.spec }
  public var collection: JSObject? { object["collection"]?.objectValue }
  public var collectionSlug: String { collection?["slug"]?.stringValue ?? "" }
  public var delimiter: String? { object["delimiter"]?.stringValue }
  public var header: Bool? { if case .bool(let b)? = object["header"] { b } else { nil } }
  public var pointer: String? { object["pointer"]?.stringValue }
  public var encoding: String? { object["encoding"]?.stringValue }

  /// `stripMapping(m)`: the mapping as stored (fields without their parsed transforms).
  public var stored: JSValue {
    var o = object
    o["fields"] = .object(JSObject(fields.map { ($0.target, JSValue.object($0.spec.raw)) }))
    return .object(o)
  }
}

/// A mapping error (`{target, message, hint, from?}`).
public struct MappingError: Sendable, Equatable {
  public var target: String?
  public var message: String
  public var hint: String
  public var from: JSValue?
}

/// What `applyMapping` gives for one record.
public struct Mapped: Sendable {
  public var doc: CanonicalDocument?
  public var extID: String?
  public var rels: [CanonicalRelationship]
  public var issues: [Issue]
  public var reject: Issue?
  /// 'parsed' | 'unparsed' per date target (nil: no value).
  public var stats: [String: String?]
}

/// The context of `applyMapping`.
public struct MappingContext: Sendable {
  public var fileName: String
  public var sha256: String
  public var decoder: String
  public var batchID: Int64?
  public var format: String
  public var byteRange: (start: Int, end: Int)?
  public var now: Date
  public var defaultKind: String?

  public init(fileName: String, sha256: String, decoder: String, batchID: Int64?, format: String,
              byteRange: (start: Int, end: Int)? = nil, now: Date, defaultKind: String? = nil) {
    self.fileName = fileName
    self.sha256 = sha256
    self.decoder = decoder
    self.batchID = batchID
    self.format = format
    self.byteRange = byteRange
    self.now = now
    self.defaultKind = defaultKind
  }
}

/// Field mapping (mapping.mjs).
public enum MappingRules {
  /// Canonical targets (§5.2) → value type. `meta.<name>` targets are passthrough.
  public static let targets: [String: String] = [
    "ext_id": "id", "title": "string", "text": "text", "author": "string", "date": "date", "date_end": "date",
    "date_precision": "string", "referenced_date": "date", "language": "lang", "kind": "string", "genre": "string",
    "community": "string", "culture": "string", "field": "string", "collection": "string", "source_url": "string",
    "license": "string", "cites": "list", "relations": "relations", "tags": "list", "notes": "string",
  ]
  /// Display order of the targets in the mapping table.
  public static let targetOrder = ["text", "title", "ext_id", "author", "date", "date_end", "date_precision", "referenced_date",
                                   "language", "kind", "genre", "community", "culture", "field", "source_url", "license", "cites",
                                   "relations", "tags", "notes", "collection"]
  /// The closed transform list (§5.2).
  public static let transforms = ["trim", "join", "split", "lower", "date", "zero_is_unknown", "map", "regex_extract"]
  static let dateTargets: Set<String> = ["date", "date_end", "referenced_date"]
  /// 20 MB per text field (§5.1).
  public static let maxFieldBytes = 20 * 1024 * 1024
  static let maxID = 512
  static let maxString = 4096
  static let precisionOrder = ["day", "month", "year", "decade", "century", "millennium"]
  static let dateOptionKeys: [(String, String)] = [("circa_radius", "circaRadius"), ("open_range_years", "openRangeYears"),
                                                   ("two_digit_century", "twoDigitCentury"), ("zero_is_unknown", "zeroIsUnknown"),
                                                   ("negative_year_convention", "negativeYearConvention")]
  /// Relationship types a file may state as documented: similarity and sense links are computed or proposed only.
  static let proposedOnlyFamilies: Set<String> = ["similarity", "sense"]

  // MARK: languages

  static let langNames: [UnitKey: String] = {
    let t: [(String, String)] = [
      ("en", "english eng anglais ingles inglés englisch अंग्रेज़ी अंग्रेजी અંગ્રેજી"),
      ("fr", "french français francais fra fre francés frances französisch फ़्रांसीसी फ्रेंच ફ્રેન્ચ"),
      ("es", "spanish español espanol castellano spa espagnol spanisch स्पेनिश સ્પેનિશ"),
      ("hi", "hindi हिन्दी हिंदी hin hindí હિન્દી"),
      ("gu", "gujarati ગુજરાતી guj gujarātī गुजराती"),
      ("de", "german deutsch ger deu allemand alemán aleman जर्मन"),
      ("la", "latin latina lat latín latein"),
      ("it", "italian italiano ita italien"),
      ("pt", "portuguese português portugues por portugais"),
      ("sa", "sanskrit संस्कृतम् संस्कृत san sanscrit sánscrito"),
      ("mr", "marathi मराठी mar"),
      ("ur", "urdu اردو urd"),
      ("bn", "bengali bangla বাংলা ben"),
      ("pa", "punjabi ਪੰਜਾਬੀ pan"),
      ("ta", "tamil தமிழ் tam"),
      ("te", "telugu తెలుగు tel"),
      ("nl", "dutch nederlands nld dut"),
      ("ru", "russian русский rus"),
      ("zh", "chinese 中文 zho chi"),
      ("ja", "japanese 日本語 jpn"),
      ("ar", "arabic العربية ara"),
    ]
    var m: [UnitKey: String] = [:]
    for (code, names) in t {
      for n in JSString.split(names, " ") { m[UnitKey(JSString.toLowerCase((n as NSString).precomposedStringWithCanonicalMapping))] = code }
    }
    return m
  }()

  /// `normalizeLang(value)`: names and 3-letter codes map to the 2-letter code; BCP-47 tags keep their subtags.
  public static func normalizeLang(_ value: String) -> String? {
    let v = JSString.trim(value)
    if v.isEmpty { return nil }
    let low = JSString.toLowerCase((v as NSString).precomposedStringWithCanonicalMapping)
    if let c = langNames[UnitKey(low)] { return c }
    // /^([a-z]{2,3})((?:[-_][a-z0-9]{2,8})*)$/i
    let u = Array(v.utf16)
    func alpha(_ c: UInt16) -> Bool { (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) }
    func alnum(_ c: UInt16) -> Bool { alpha(c) || (c >= 0x30 && c <= 0x39) }
    var i = 0
    while i < u.count && alpha(u[i]) && i < 3 { i += 1 }
    // the primary subtag is 2–3 letters; with backtracking a 3-letter run may end at 2 when a subtag follows directly
    for p in stride(from: i, through: 2, by: -1) {
      var k = p
      var ok = true
      while k < u.count {
        guard u[k] == 0x2D || u[k] == 0x5F else { ok = false; break }
        var e = k + 1
        while e < u.count && alnum(u[e]) && e - k - 1 < 8 { e += 1 }
        if e - k - 1 < 2 { ok = false; break }
        k = e
      }
      if ok && k == u.count {
        let primary = Fold.asciiLowercased(String(decoding: u[0..<p], as: UTF16.self))
        let p2 = p == 3 ? langNames[UnitKey(primary)] ?? primary : primary
        let rest = String(decoding: u[p...].map { $0 == 0x5F ? 0x2D : $0 }, as: UTF16.self)
        return p2 + rest
      }
    }
    return nil
  }

  // MARK: transforms

  static func unescapeDelim(_ s: String) -> String {
    JSString.split(JSString.split(JSString.split(s, "\\t").joined(separator: "\t"), "\\n").joined(separator: "\n"), "\\f")
      .joined(separator: "\u{0C}")
  }

  struct TransformError: Error { let message: String }

  /// `normalizeTransform(t)`.
  static func normalizeTransform(_ t: JSValue) throws -> Transform {
    if case .string(let s) = t {
      // /^([a-z_]+)(?:\((.*)\))?$/s on the trimmed name
      let u = Array(JSString.trim(s).utf16)
      var i = 0
      while i < u.count && ((u[i] >= 0x61 && u[i] <= 0x7A) || u[i] == 0x5F) { i += 1 }
      let name = String(decoding: u[0..<i], as: UTF16.self)
      var arg: String?
      if i < u.count {
        guard u[i] == 0x28, u.last == 0x29, u.count >= i + 2 else { throw TransformError(message: "Unknown transform '\(s)'.") }
        arg = String(decoding: u[(i + 1)..<(u.count - 1)], as: UTF16.self)
      }
      guard i > 0, transforms.contains(name) else { throw TransformError(message: "Unknown transform '\(s)'.") }
      switch name {
      case "split": return .split(unescapeDelim(arg ?? ";"))
      case "join": return .join(unescapeDelim(arg ?? "; "))
      case "date": return .date(JSObject())
      case "map", "regex_extract": throw TransformError(message: "Transform '\(name)' needs an object form, e.g. {\"\(name)\": …}.")
      case "trim": return .trim
      case "lower": return .lower
      default: return .zeroIsUnknown
      }
    }
    guard case .object(let o) = t else {
      throw TransformError(message: "A transform is a name or a one-key object (got \(JSText.stringify(t))).")
    }
    let keys = o.keys
    guard keys.count == 1, transforms.contains(keys[0]) else { throw TransformError(message: "Unknown transform \(JSText.stringify(t)).") }
    let op = keys[0], arg = o[op]!
    switch op {
    case "split", "join":
      guard case .string(let d) = arg, !d.isEmpty else { throw TransformError(message: "\(op) needs a delimiter string.") }
      return op == "split" ? .split(unescapeDelim(d)) : .join(unescapeDelim(d))
    case "date":
      let a: JSObject
      switch arg {
      case .null: a = JSObject()
      case .object(let x): a = x
      default: throw TransformError(message: "date options must be an object.")
      }
      for k in a.keys where !dateOptionKeys.contains(where: { $0.0 == k }) {
        throw TransformError(message: "Unknown date option '\(k)' (use \(dateOptionKeys.map(\.0).joined(separator: ", "))).")
      }
      func int(_ v: JSValue?) -> Int? { if case .number(let n)? = v, n == n.rounded(.towardZero), abs(n) < 9e15 { Int(n) } else { nil } }
      if let v = a["circa_radius"], !(int(v).map { $0 >= 0 && $0 <= 100 } ?? false) {
        throw TransformError(message: "circa_radius must be a whole number of years (0–100).")
      }
      if let v = a["open_range_years"], !(int(v).map { $0 >= 1 && $0 <= 1000 } ?? false) {
        throw TransformError(message: "open_range_years must be 1–1000.")
      }
      if let v = a["two_digit_century"], !v.isNull, !(int(v).map { [17, 18, 19, 20, 1700, 1800, 1900, 2000].contains($0) } ?? false) {
        throw TransformError(message: "two_digit_century must be null, 18, 19 or 20 (for 18xx, 19xx, 20xx).")
      }
      if let v = a["negative_year_convention"], !(["historical", "astronomical"].contains(v.stringValue ?? "\u{0}")) {
        throw TransformError(message: "negative_year_convention is 'historical' or 'astronomical'.")
      }
      return .date(a)
    case "map":
      guard case .object(let m) = arg else { throw TransformError(message: "map needs an object of value → replacement.") }
      return .map(m)
    case "regex_extract":
      var pattern: String?, group: JSValue?
      switch arg {
      case .string(let s): pattern = s
      case .array(let a):
        pattern = a.first?.stringValue
        group = a.count > 1 ? a[1] : nil
      case .object(let x):
        pattern = x["pattern"]?.stringValue
        group = x["group"]
      default: break
      }
      guard let pattern else { throw TransformError(message: "regex_extract needs a pattern.") }
      guard (try? NSRegularExpression(pattern: pattern)) != nil else {
        throw TransformError(message: "regex_extract pattern is not valid: Invalid regular expression: /\(pattern)/u")
      }
      let hasGroup = Array(pattern.utf16).enumerated().contains { k, c in c == 0x28 && (k + 1 >= pattern.utf16.count || Array(pattern.utf16)[k + 1] != 0x3F) }
      let g = (group?.isNull ?? true) ? JSValue.number(hasGroup ? 1 : 0) : group!
      switch g {
      case .number(let n) where n >= 0 && n == n.rounded(.towardZero): break
      case .string: break
      default: throw TransformError(message: "regex_extract group must be a number or a group name.")
      }
      return .regexExtract(pattern: pattern, group: g)
    case "trim": return .trim
    case "lower": return .lower
    default: return .zeroIsUnknown
    }
  }

  /// `describeTransforms(list)`: 'trim, date(circa_radius=5)'.
  public static func describe(_ list: [Transform]) -> String? {
    let s = list.map { t -> String in
      switch t {
      case .split(let a), .join(let a):
        let q = CanonicalJSON.quote(a)
        return "\(t.op)(\(JSString.slice(q, 1, -1)))"
      case .date(let a):
        let parts = a.entries.filter { !$0.value.isNull }.map { "\($0.key)=\(JSText.string($0.value))" }
        return "date(\(parts.joined(separator: ", ")))"
      case .map(let m): return "map(\(m.count) values)"
      case .regexExtract(let p, let g): return "regex_extract(/\(p)/, \(JSText.string(g)))"
      default: return t.op
      }
    }.joined(separator: ", ")
    return s.isEmpty ? nil : s
  }

  /// The date options a transform list collects (`dateOpts` of runTransforms).
  struct DateOpts {
    var isDate = false
    var values: [String: JSValue] = [:]
  }

  /// `runTransforms(value, list, dateOpts)`.
  static func run(_ value: JSValue?, _ list: [Transform], _ opts: inout DateOpts) -> JSValue? {
    var v = value
    for t in list {
      switch t {
      case .trim:
        if case .array(let a)? = v { v = .array(a.map { if case .string(let s) = $0 { .string(JSString.trim(s)) } else { $0 } }) }
        else if case .string(let s)? = v { v = .string(JSString.trim(s)) }
      case .lower:
        if case .array(let a)? = v { v = .array(a.map { if case .string(let s) = $0 { .string(JSString.toLowerCase(s)) } else { $0 } }) }
        else if case .string(let s)? = v { v = .string(JSString.toLowerCase(s)) }
      case .split(let d):
        if case .string(let s)? = v {
          let parts = d.isEmpty ? s.utf16.map { String(decoding: [$0], as: UTF16.self) } : JSString.split(s, d)
          v = .array(parts.map { JSString.trim($0) }.filter { !$0.isEmpty }.map(JSValue.string))
        }
      case .join(let d):
        if case .array(let a)? = v { v = .string(a.filter { !$0.isNull }.map(JSText.string).joined(separator: d)) }
      case .map(let m):
        func lookup(_ x: JSValue) -> JSValue {
          let s: String
          switch x {
          case .string(let str): s = str
          case .number(let n): s = JSNumber.format(n)
          default: return x
          }
          if let hit = m[s] { return hit }
          let want = JSString.toLowerCase(JSString.trim(s))
          if let key = m.keys.first(where: { JSString.equal(JSString.toLowerCase(JSString.trim($0)), want) }) { return m[key]! }
          return x
        }
        if case .array(let a)? = v { v = .array(a.map(lookup)) } else if let x = v { v = lookup(x) }
      case .regexExtract(let pattern, let group):
        let re = try? NSRegularExpression(pattern: pattern)
        func one(_ x: JSValue) -> JSValue {
          guard case .string(let s) = x, let re else { return x }
          let ns = s as NSString
          guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return .null }
          let r: NSRange
          switch group {
          case .string(let name):
            // NSRegularExpression raises for a name the pattern does not define (JavaScript gives undefined)
            r = pattern.contains("(?<\(name)>") ? m.range(withName: name) : NSRange(location: NSNotFound, length: 0)
          case .number(let n): r = Int(n) < m.numberOfRanges ? m.range(at: Int(n)) : NSRange(location: NSNotFound, length: 0)
          default: r = NSRange(location: NSNotFound, length: 0)
          }
          return r.location == NSNotFound ? .null : .string(ns.substring(with: r))
        }
        if case .array(let a)? = v { v = .array(a.map(one).filter { !$0.isNull }) } else if let x = v { v = one(x) }
      case .zeroIsUnknown:
        opts.values["zeroIsUnknown"] = .bool(true)
        var isZero = false
        if case .number(let n)? = v, n == 0 { isZero = true }
        if case .string(let s)? = v {
          let t = Array(JSString.trim(s).utf16)
          isZero = !t.isEmpty && t.allSatisfy { $0 == 0x30 }
        }
        if isZero && !opts.isDate { v = .null }
      case .date(let a):
        for (k, x) in a.entries {
          if let key = dateOptionKeys.first(where: { $0.0 == k })?.1 { opts.values[key] = x }
        }
      }
    }
    return v
  }

  // MARK: normalization

  /// `normalizeMapping(raw)`: defaults filled, transforms parsed; `errors` lists what makes it unusable.
  public static func normalize(_ raw: JSValue?) -> (mapping: Mapping, errors: [MappingError]) {
    var errors: [MappingError] = []
    let m: JSObject
    if case .object(let o)? = raw { m = o } else {
      m = JSObject()
      errors.append(MappingError(target: nil, message: "The mapping must be an object.", hint: "Send {\"mapping\": {\"fields\": {…}}}.", from: nil))
    }
    var options = JSObject([("dedupe", .string("flag")), ("detect_language", .bool(true)), ("on_bad_row", .string("skip_and_report")),
                            ("line_mode", .bool(false))])
    if case .object(let given)? = m["options"] { for (k, v) in given.entries { options[k] = v } }
    let dedupe = options["dedupe"]!, onBad = options["on_bad_row"]!
    if !["flag", "skip", "off"].contains(dedupe.stringValue ?? "\u{0}") {
      errors.append(MappingError(target: nil, message: "options.dedupe '\(JSText.string(dedupe))' is not flag, skip or off.",
                                 hint: "Use 'flag' (keep duplicates, excluded from counts by default).", from: nil))
    }
    if !["skip_and_report", "abort"].contains(onBad.stringValue ?? "\u{0}") {
      errors.append(MappingError(target: nil, message: "options.on_bad_row '\(JSText.string(onBad))' is not skip_and_report or abort.",
                                 hint: "Use 'skip_and_report'.", from: nil))
    }
    var fields: [(String, FieldSpec)] = []
    let rawFields = m["fields"]?.objectValue ?? JSObject()
    for (target, spec) in rawFields.entries {
      if targets[target] == nil && !isMetaTarget(target) {
        errors.append(MappingError(target: target, message: "'\(target)' is not a target field.",
                                   hint: "Targets: \(targetOrder.joined(separator: ", ")), or meta.<name>.", from: nil))
        continue
      }
      if spec.isNull { continue }
      guard case .object(let s) = spec else {
        errors.append(MappingError(target: target, message: "Target '\(target)' must be {\"from\": …} or {\"const\": …}.",
                                   hint: "Pick a column, or type a constant.", from: nil))
        continue
      }
      let from = s["from"]
      let hasFrom = from != nil && !(from!.isNull) && from!.stringValue != ""
      let hasConst = s.has("const")
      if hasFrom == hasConst {
        if !hasFrom && !hasConst { continue }  // "not mapped"
        errors.append(MappingError(target: target, message: "Target '\(target)' has both a column and a constant.", hint: "Keep one of them.", from: nil))
        continue
      }
      var list: [Transform] = []
      let rawList: [JSValue]
      switch s["transform"] {
      case .array(let a)?: rawList = a
      case nil, .null?, .bool(false)?, .string("")?, .number(0)?: rawList = []
      case let x?: rawList = [x]
      }
      for t in rawList {
        do {
          let n = try normalizeTransform(t)
          if case .date = n, !dateTargets.contains(target) {
            throw TransformError(message: "date() only applies to \(["date", "date_end", "referenced_date"].joined(separator: ", ")).")
          }
          list.append(n)
        } catch {
          errors.append(MappingError(target: target, message: "Target '\(target)': \((error as? TransformError)?.message ?? "\(error)")",
                                     hint: "Transforms: \(transforms.joined(separator: ", ")).", from: nil))
        }
      }
      fields.append((target, FieldSpec(from: s["from"], constValue: s["const"], transforms: list, reason: s["reason"]?.stringValue, raw: s)))
    }
    var object = m
    object["options"] = .object(options)
    object["fields"] = .object(JSObject(fields.map { ($0.0, JSValue.object($0.1.raw)) }))
    if case .object(let c)? = m["collection"] { object["collection"] = .object(c) } else { object["collection"] = .null }
    let mapping = Mapping(object: object, format: m["format"]?.stringValue ?? "", fields: fields, dedupe: dedupe.stringValue ?? "flag",
                          detectLanguage: !(options["detect_language"].map { if case .bool(false) = $0 { true } else { false } } ?? false),
                          onBadRow: onBad.stringValue ?? "skip_and_report", lineMode: isTruthy(options["line_mode"]))
    return (mapping, errors)
  }

  /// `/^meta\.[\p{L}\p{N}_ .-]{1,64}$/u`
  static func isMetaTarget(_ t: String) -> Bool {
    guard t.hasPrefix("meta.") else { return false }
    let rest = Array(t.unicodeScalars.dropFirst(5))
    guard (1...64).contains(rest.count) else { return false }
    return rest.allSatisfy { s in
      s == "_" || s == " " || s == "." || s == "-" || !TokenClassTable.classes(s.value).isDisjoint(with: [.letter, .number])
    }
  }

  static func isTruthy(_ v: JSValue?) -> Bool {
    switch v {
    case nil, .null?: false
    case .bool(let b)?: b
    case .number(let n)?: n != 0 && !n.isNaN
    case .string(let s)?: !s.isEmpty
    default: true
    }
  }

  /// `sourceValue(data, from)`: a key, a 1-based column number, or a JSON Pointer inside the record.
  public static func sourceValue(_ data: JSObject?, _ from: JSValue?) -> JSValue? {
    guard let data, let from else { return nil }
    if case .number(let n) = from {
      let vals = data.values
      let k = Int(exactly: n).map { $0 - 1 } ?? -1
      return k >= 0 && k < vals.count ? vals[k] : nil
    }
    let key = JSText.string(from)
    if let v = data[key] { return v }
    if case .string(let s) = from, s.hasPrefix("/"), let tokens = try? JSONRecords.pointerTokens(s) {
      return JSONRecords.getPointer(.object(data), tokens)
    }
    return nil
  }
}
