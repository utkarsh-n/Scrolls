// OWNER: N0
// The value types of the date grammar (SPEC §5.3): a DateParse is what `parseDate` returns, with its issue when the
// input is not a date. They encode as the reference's JSON (`lo_day`, `hi_day`, `lo_year`, `hi_year`, …, approx 0/1).

/// Why a raw date could not be read (`{issue: {code, message, suggestions}}`). The importer records it and imports
/// the row as undated.
public struct DateIssue: Sendable, Codable, Equatable {
  public var code: String
  public var message: String
  public var suggestions: [String]
  public init(code: String, message: String, suggestions: [String]) {
    self.code = code
    self.message = message
    self.suggestions = suggestions
  }
}

/// A parsed date: an inclusive day interval with its precision, basis and the grammar rule that read it.
/// When `issue` is set the parse is undated (`loDay == nil`) and the issue says why.
public struct DateParse: Sendable, Equatable {
  public var loDay: Day?
  public var hiDay: Day?
  public var yLo: Int32?
  public var yHi: Int32?
  /// 'day' | 'month' | 'year' | 'decade' | 'century' | 'millennium' | 'range' | 'period' | 'unknown'
  public var precision: String
  /// 'stated' | 'estimated' | 'derived' | 'period' | 'announced' | 'unknown'
  public var basis: String
  /// The circa qualifier.
  public var approx: Bool
  /// The grammar rule id ('year', 'circa', 'vikram_samvat', 'year+future', …).
  public var rule: String
  /// The input verbatim (nil when there was none).
  public var raw: String?
  /// `formatDateLabel(self)`.
  public var label: String
  /// Issue codes of warnings (W_DATE_FUTURE, W_AMBIGUOUS_HUNDREDS, W_DATE_SEASON).
  public var warnings: [String]
  /// Set when the input is not a date (E_DATE_UNPARSEABLE, E_DATE_AMBIGUOUS, E_DATE_INVALID).
  public var issue: DateIssue?

  public init(loDay: Day?, hiDay: Day?, yLo: Int32?, yHi: Int32?, precision: String, basis: String, approx: Bool,
              rule: String, raw: String?, label: String, warnings: [String], issue: DateIssue? = nil) {
    self.loDay = loDay
    self.hiDay = hiDay
    self.yLo = yLo
    self.yHi = yHi
    self.precision = precision
    self.basis = basis
    self.approx = approx
    self.rule = rule
    self.raw = raw
    self.label = label
    self.warnings = warnings
    self.issue = issue
  }

  /// The undated result that carries an issue.
  static func failed(_ issue: DateIssue, raw: String?) -> DateParse {
    DateParse(loDay: nil, hiDay: nil, yLo: nil, yHi: nil, precision: "unknown", basis: "unknown", approx: false,
              rule: "unknown", raw: raw, label: "undated", warnings: [], issue: issue)
  }

  /// The reference's JSON: the parse object, or `{"issue": {…}}`.
  public var jsonValue: JSONValue {
    if let issue {
      return ["issue": ["code": .string(issue.code), "message": .string(issue.message),
                        "suggestions": .array(issue.suggestions.map(JSONValue.string))]]
    }
    func n(_ v: Int32?) -> JSONValue { v.map { .number(Double($0)) } ?? .null }
    return .object([
      "lo_day": n(loDay), "hi_day": n(hiDay), "lo_year": n(yLo), "hi_year": n(yHi), "precision": .string(precision),
      "basis": .string(basis), "approx": .number(approx ? 1 : 0), "rule": .string(rule), "raw": raw.map(JSONValue.string) ?? .null,
      "label": .string(label), "warnings": .array(warnings.map(JSONValue.string)),
    ])
  }
}

extension DateParse: Codable {
  /// Decodes the reference's JSON through `JSONValue`, whose keys no encoder key strategy rewrites.
  public init(from decoder: any Decoder) throws {
    let v = try JSONValue(from: decoder)
    func bad(_ what: String) -> DecodingError {
      .dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "DateParse: \(what)"))
    }
    if let i = v["issue"], !i.isNull {
      guard let code = i["code"]?.stringValue, let message = i["message"]?.stringValue else { throw bad("issue without code/message") }
      self = .failed(DateIssue(code: code, message: message, suggestions: i["suggestions"]?.arrayValue?.compactMap(\.stringValue) ?? []),
                     raw: nil)
      return
    }
    func int32(_ key: String) -> Int32? { v[key]?.safeInteger.map { Int32(clamping: $0) } }
    guard let precision = v["precision"]?.stringValue, let basis = v["basis"]?.stringValue, let rule = v["rule"]?.stringValue,
      let label = v["label"]?.stringValue
    else { throw bad("missing precision, basis, rule or label") }
    self.init(loDay: int32("lo_day"), hiDay: int32("hi_day"), yLo: int32("lo_year"), yHi: int32("hi_year"), precision: precision,
              basis: basis, approx: (v["approx"]?.safeInteger ?? 0) != 0, rule: rule, raw: v["raw"]?.stringValue, label: label,
              warnings: v["warnings"]?.arrayValue?.compactMap(\.stringValue) ?? [])
  }

  /// Encodes `jsonValue`: the parse object, or `{"issue": {…}}`.
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }
}

/// How a bare negative year is read: historical (−300 = 300 BCE = astronomical −299; the default) or astronomical.
public enum NegativeYearConvention: String, Sendable, Codable {
  case historical, astronomical
}

/// The options of `parseDate` (an import mapping's date settings) and the clock it reads.
public struct DateContext: Sendable, Equatable {
  /// ± years of a circa year (default 5).
  public var circaRadius: Int
  /// Years on the open side of 'before 1850' / 'after 1850' (default 50).
  public var openRangeYears: Int
  /// The century of two-digit decades ('90s'): 19 or 1900; nil asks (E_DATE_AMBIGUOUS).
  public var twoDigitCentury: Int?
  /// Read '0' as unknown.
  public var zeroIsUnknown: Bool
  public var negativeYearConvention: NegativeYearConvention
  /// Today's UTC day number: later dates are 'announced' (the Scheduled shelf).
  public var now: Int

  public init(circaRadius: Int = 5, openRangeYears: Int = 50, twoDigitCentury: Int? = nil, zeroIsUnknown: Bool = false,
              negativeYearConvention: NegativeYearConvention = .historical, now: Int = DayMath.today()) {
    self.circaRadius = circaRadius
    self.openRangeYears = openRangeYears
    self.twoDigitCentury = twoDigitCentury
    self.zeroIsUnknown = zeroIsUnknown
    self.negativeYearConvention = negativeYearConvention
    self.now = now
  }
}
