// OWNER: N0
// Port of the date grammar of src/shared/dates.mjs (SPEC §5.3): same rules in the same order, same rule ids, issue
// codes, messages and suggestions. Golden g1.dates holds every distinct raw date value of the corpus snapshots, the
// reference's own test inputs, the §5.3 examples and 2,000 fuzz strings.
//
// Regular expressions run on ICU (NSRegularExpression) with the JavaScript semantics made explicit:
//  · `\d` is written [0-9] (ICU's \d also matches other scripts' digits; JavaScript's does not);
//  · `.` matches every code point and `$` only the end of input (dotMatchesLineSeparators + useUnixLineSeparators):
//    after prep() the only line terminator left is U+0085, which JavaScript's `.` matches and its `$` does not see;
//  · whole-string alternations of literals (seasons, unknown words) compare UTF-16 code units, as `===` does.

import Foundation

/// Why `fromInterval` / `fromDayInterval` refused their arguments (the reference throws a RangeError).
public struct DateGrammarError: Error, Sendable, Equatable {
  public let message: String
  public init(message: String) { self.message = message }
}

/// The date grammar of SPEC §5.3.
public enum DateGrammar {
  /// `parseDate(raw, options)`: a dated, undated ('unknown') or failed (`issue` set) parse of a date as written.
  /// A date after `context.now` gets basis 'announced', rule '<rule>+future' and W_DATE_FUTURE (Scheduled shelf).
  public static func parse(_ raw: String?, context: DateContext) -> DateParse {
    let s = raw.map(prep) ?? ""
    if unknownWords.contains(s) || (context.zeroIsUnknown && !s.isEmpty && s.utf16.allSatisfy { $0 == 0x30 }) {
      return build(nil, nil, precision: "unknown", basis: "unknown", approx: false, rule: "unknown", raw: raw, warnings: [])
    }
    let opts = Options(context: context, raw: raw)
    let t = leadingPreposition.replaceFirst(s, with: "")
    guard let r = single(t, opts) ?? range(t, opts) else {
      let suggestions = suggestionsFor(t, opts)
      let hint = suggestions.isEmpty ? "" : "; try " + suggestions.map { "'\($0)'" }.joined(separator: " or ")
      return .failed(DateIssue(code: "E_DATE_UNPARSEABLE", message: "Date '\(raw ?? "null")' was not recognised\(hint).",
                               suggestions: Array(suggestions.prefix(3))), raw: raw)
    }
    switch r {
    case .issue(let issue):
      return .failed(issue, raw: raw)
    case .ok(let v):
      var basis = v.basis, rule = v.rule, warnings = v.warnings
      if v.lo > context.now {
        basis = "announced"
        rule += "+future"
        warnings.append("W_DATE_FUTURE")
      }
      return build(v.lo, v.hi, precision: v.precision, basis: basis, approx: v.approx, rule: rule, raw: raw, warnings: warnings)
    }
  }

  /// `fromInterval(loYear, hiYear, opts)`: a whole-year interval stated by a source (adapters, language periods).
  /// `precision` nil infers it (year, decade, century, millennium or range).
  public static func fromInterval(_ loYear: Int, _ hiYear: Int, precision: String? = nil, basis: String? = nil,
                                  rule: String = "interval", raw: String? = nil, approx: Bool = false) throws(DateGrammarError) -> DateParse {
    guard loYear <= hiYear else { throw DateGrammarError(message: "fromInterval: invalid years \(loYear)…\(hiYear)") }
    return build(DayMath.dayFromYMD(loYear, 1, 1), DayMath.dayFromYMD(hiYear, 12, 31),
                 precision: precision ?? inferPrecision(loYear, hiYear), basis: basis ?? "stated", approx: approx, rule: rule,
                 raw: raw, warnings: [])
  }

  /// `fromDayInterval(loDay, hiDay, opts)`: an explicit day interval (e.g. an OpenAlex publication_date).
  public static func fromDayInterval(_ loDay: Int, _ hiDay: Int, precision: String, basis: String = "stated",
                                     rule: String = "interval", raw: String? = nil, approx: Bool = false) throws(DateGrammarError) -> DateParse {
    guard loDay <= hiDay else { throw DateGrammarError(message: "fromDayInterval: invalid days \(loDay)…\(hiDay)") }
    return build(loDay, hiDay, precision: precision, basis: basis, approx: approx, rule: rule, raw: raw, warnings: [])
  }

  // MARK: - Building results

  static func build(_ lo: Int?, _ hi: Int?, precision: String, basis: String, approx: Bool, rule: String, raw: String?,
                    warnings: [String]) -> DateParse {
    var p = DateParse(loDay: lo.map { Day(clamping: $0) }, hiDay: hi.map { Day(clamping: $0) },
                      yLo: lo.map { Int32(clamping: DayMath.ymdFromDay($0).y) }, yHi: hi.map { Int32(clamping: DayMath.ymdFromDay($0).y) },
                      precision: precision, basis: basis, approx: approx, rule: rule, raw: raw, label: "", warnings: warnings)
    p.label = DateLabels.formatDateLabel(p)
    return p
  }

  static func inferPrecision(_ lo: Int, _ hi: Int) -> String {
    if lo == hi { return "year" }
    if lo % 10 == 0 && hi == lo + 9 { return "decade" }
    if DateLabels.centuryLabel(lo, hi) != nil { return "century" }
    if DateLabels.millenniumLabel(lo, hi) != nil { return "millennium" }
    return "range"
  }

  struct Options {
    var context: DateContext
    var raw: String?
    var rawText: String { raw ?? "null" }  // `${opts.raw}` of a missing raw
  }

  struct Interval {
    var lo: Int, hi: Int
    var precision: String, basis: String, rule: String
    var approx = false
    var warnings: [String] = []
  }

  enum Reading {
    case ok(Interval)
    case issue(DateIssue)
    var isIssue: Bool { if case .issue = self { return true } else { return false } }
  }

  enum YearAtom {
    case year(Int, rule: String)
    case issue(DateIssue)
  }

  static func span(_ loY: Int, _ hiY: Int) -> (Int, Int) { (DayMath.dayFromYMD(loY, 1, 1), DayMath.dayFromYMD(hiY, 12, 31)) }

  static func ok(_ s: (Int, Int), _ precision: String, _ basis: String, _ rule: String, approx: Bool = false,
                 warnings: [String] = []) -> Reading {
    .ok(Interval(lo: s.0, hi: s.1, precision: precision, basis: basis, rule: rule, approx: approx, warnings: warnings))
  }

  static func issue(_ code: String, _ message: String, _ suggestions: [String] = []) -> DateIssue {
    DateIssue(code: code, message: message, suggestions: Array(suggestions.prefix(3)))
  }

  // MARK: - prep

  /// Lower-case, NFC, Indic digits → ASCII, Latin accents and nukta dropped, dashes and quotes unified, whitespace
  /// collapsed and trimmed.
  static func prep(_ raw: String) -> String {
    var u: [UInt16] = []
    for c in (raw as NSString).precomposedStringWithCanonicalMapping.utf16 {
      switch c {
      case 0x0966...0x096F: u.append(0x30 + (c - 0x0966))
      case 0x0AE6...0x0AEF: u.append(0x30 + (c - 0x0AE6))
      case 0x200B...0x200D, 0x2060, 0xFEFF, 0x00AD: continue
      case 0x2010, 0x2011, 0x2212: u.append(0x2D)
      case 0x2012...0x2015: u.append(0x2013)
      case 0x2018, 0x2019, 0x02BC, 0x2032, 0x60, 0x00B4: u.append(0x27)
      default: u.append(c)
      }
    }
    let lower = JSString.toLowerCase(String(decoding: u, as: UTF16.self))
    let nfd = (lower as NSString).decomposedStringWithCanonicalMapping
    let stripped = nfd.utf16.filter { !(0x0300...0x036F).contains($0) && $0 != 0x093C && $0 != 0x0ABC }
    let nfc = (String(decoding: stripped, as: UTF16.self) as NSString).precomposedStringWithCanonicalMapping
    var out: [UInt16] = []
    var inSpace = false
    for c in nfc.utf16 {
      if JSString.isWhitespace(c) {
        if !inSpace { out.append(0x20) }
        inSpace = true
      } else {
        out.append(c)
        inSpace = false
      }
    }
    return JSString.trim(String(decoding: out, as: UTF16.self))
  }

  // MARK: - Vocabulary

  private static let monthTable: [(Int, String)] = [
    (1, "january jan janvier janv enero ene जनवरी જાન્યુઆરી"),
    (2, "february feb fevrier fevr fev febrero फरवरी ફેબ્રુઆરી"),
    (3, "march mar mars marzo मार्च માર્ચ"),
    (4, "april apr avril avr abril abr अप्रैल अप्रेल એપ્રિલ"),
    (5, "may mai mayo मई મે"),
    (6, "june jun juin junio जून જૂન જુન"),
    (7, "july jul juillet juil julio जुलाई જુલાઈ જુલાઇ"),
    (8, "august aug aout agosto ago अगस्त ઑગસ્ટ ઓગસ્ટ ઑગષ્ટ ઓગષ્ટ"),
    (9, "september sept sep septembre septiembre setiembre set सितंबर सितम्बर સપ્ટેમ્બર"),
    (10, "october oct octobre octubre अक्टूबर अक्तूबर ઑક્ટોબર ઓક્ટોબર"),
    (11, "november nov novembre noviembre नवंबर नवम्बर નવેમ્બર"),
    (12, "december dec decembre diciembre dic दिसंबर दिसम्बर ડિસેમ્બર"),
  ]

  /// `MONTH_NAMES`: prepped name → month, in Map insertion order (a repeated name keeps its first position).
  static let monthNames: OrderedMap<Int> = OrderedMap(monthTable.flatMap { m, names in
    JSString.split(names, " ").map { (prep($0), m) }
  })

  /// `MONTH_ALT`: the names longest first (stable on ties), escaped, as one alternation.
  static let monthAlt: String = monthNames.keys.enumerated()
    .sorted { $0.element.utf16.count != $1.element.utf16.count ? $0.element.utf16.count > $1.element.utf16.count : $0.offset < $1.offset }
    .map { NSRegularExpression.escapedPattern(for: $0.element) }
    .joined(separator: "|")

  private static let unknownWords: Set<String> = Set([
    "", "unknown", "undated", "no date", "n.d.", "n. d.", "n.d", "nd", "s.d.", "s. d.", "s.d", "s.f.", "s. f.", "s.f",
    "sin fecha", "sans date", "date inconnue", "fecha desconocida", "?", "??", "???", "-", "–", "n/a", "na", "null", "none",
    "अज्ञात", "तिथि अज्ञात", "અજ્ઞાત", "તારીખ અજ્ઞાત",
  ].map(prep))

  private static let circaPrefixes: [String] = [
    "approximately", "aproximadamente", "hacia el ano", "cerca de", "around", "environ", "approx.", "approx", "aprox.", "aprox",
    "circa", "about", "hacia", "vers", "env.", "cca.", "cca", "ca.", "ca", "c.", "c", "~", "≈", "लगभग", "करीब", "લગભગ", "આશરે",
    "અંદાજે",
  ].map { ($0 as NSString).precomposedStringWithCanonicalMapping }

  private static let seasons: [(words: [String], name: String, m0: Int, m1: Int)] = [
    (["spring", "printemps", "primavera", "वसंत", "बसंत", "વસંત"], "spring", 3, 5),
    (["summer", "ete", "verano", "गर्मी", "ग्रीष्म", "ઉનાળો", "ગ્રીષ્મ"], "summer", 6, 8),
    (["autumn", "fall", "automne", "otono", "पतझड़", "पतझड", "शरद", "પાનખર", "શરદ"], "autumn", 9, 11),
    (["easter", "paques", "pascua", "semana santa", "ईस्टर"], "Easter", 3, 4),
    (["winter", "hiver", "invierno", "सर्दी", "शीत", "શિયાળો"], "winter", 0, 0),
  ]

  private static let suggestSeasons: [(String, [String])] = [
    ("spring", ["spring", "printemps", "primavera"]), ("summer", ["summer", "ete", "verano"]),
    ("autumn", ["autumn", "fall", "automne", "otono"]), ("Easter", ["easter", "paques", "pascua"]),
  ]

  // MARK: - Patterns

  static let bce = #"(?:bce|b\.c\.e\.?|bc|b\.c\.?|av\.? ?j\.?-?c\.?|a\.? ?c\.?|a\.? de ?c\.?|ईसा पूर्व|ई\.? ?पू\.?|ઈ\.? ?સ\.? ?પૂ\.?|ઈસવીસન પૂર્વે)"#
  static let ceSuffix = #"(?:ce|c\.e\.?|ad|a\.d\.?|ap\.? ?j\.?-?c\.?|d\.? ?c\.?|d\.? de ?c\.?|ईस्वी|ई\.?|ઈ\.? ?સ\.?)"#
  static let cePrefix = #"(?:ad|a\.d\.?|सन्?|ई\.? ?स\.?|ઈ\.? ?સ\.?|year|ano|annee|an)"#
  static let bceTail = "(?: ?(\(bce)))?"

  private static let reYearDigits = JSRegex(#"^([0-9]{1,4})$"#)
  private static let reBceYear = JSRegex(#"^([0-9]{1,5}) ?"# + bce + "$")
  private static let reCeYear = JSRegex(#"^([0-9]{1,4}) ?"# + ceSuffix + "$")
  private static let reCePrefixYear = JSRegex("^" + cePrefix + #" ?([0-9]{1,4})$"#)
  private static let reNegativeYear = JSRegex(#"^-([0-9]{1,5})$"#)

  private static let reCentury1 = JSRegex(#"^([0-9]{1,2})(?:st|nd|rd|th) (?:century|cent\.?|c\.?)"# + bceTail + "$")
  private static let reCentury2 = JSRegex(#"^([ivxlc]+|[0-9]{1,2}) ?(?:e|eme|er|ieme) (?:siecle|s\.)"# + bceTail + "$")
  private static let reCentury3 = JSRegex(#"^(?:siglo|s\.) ?([ivxlc]+|[0-9]{1,2})"# + bceTail + "$")
  private static let reCentury4 = JSRegex(#"^([0-9]{1,2}) ?(?:वीं|वी|वां|वाँ)? ?(?:सदी|शताब्दी|शती)$"#)
  private static let reCentury5 = JSRegex(#"^([0-9]{1,2}) ?(?:મી|માં|મો)? ?સદી$"#)
  private static let reMillennium1 = JSRegex(#"^([0-9]{1,2})(?:st|nd|rd|th) millennium"# + bceTail + "$")
  private static let reMillennium2 = JSRegex(#"^([ivx]+|[0-9]{1,2}) ?(?:e|er|eme|ieme) millenaire"# + bceTail + "$")
  private static let reMillennium3 = JSRegex(#"^(?:([ivx]+|[0-9]{1,2})(?:º|o|er)? milenio|milenio ([ivx]+|[0-9]{1,2}))"# + bceTail + "$")

  private static let reShaka = JSRegex(#"^(?:शक(?: संवत)?|शके|શક(?: સંવત)?|saka(?: era| samvat)?|shaka(?: samvat)?) ?([0-9]{1,4})$"#)
  private static let reVikram1 = JSRegex(
    #"^(?:विक्रम संवत|वि\.? ?सं\.?|संवत|सम्वत|सं\.|વિક્રમ સંવત|વિ\.? ?સં\.?|સંવત|vikram samvat|samvat|v\. ?s\.|vs) ?([0-9]{1,4})$"#)
  private static let reVikram2 = JSRegex(#"^([0-9]{1,4}) ?(?:vs|v\. ?s\.|संवत|સંવત)$"#)
  private static let reIsoDay = JSRegex(
    #"^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[t ][0-9]{1,2}:[0-9]{2}(?::[0-9]{2}(?:[.,][0-9]+)?)?(?: ?(?:z|utc|[+-][0-9]{2}(?::?[0-9]{2})?))?)?$"#)
  private static let reSlashDay = JSRegex(#"^([0-9]{4})[/.]([0-9]{1,2})[/.]([0-9]{1,2})$"#)
  private static let reNumericDay = JSRegex(#"^([0-9]{1,2})[/.-]([0-9]{1,2})[/.-]([0-9]{4})$"#)
  private static let reIsoMonth = JSRegex(#"^([0-9]{4})-([0-9]{1,2})$"#)
  private static let reDayMonthYear = JSRegex(#"^([0-9]{1,2})(?:st|nd|rd|th|er|º|°|o)?\.? (?:de )?("# + monthAlt + #")\.?,? (?:de |del )?(.+)$"#)
  private static let reMonthDayYear = JSRegex("^(" + monthAlt + #")\.? ([0-9]{1,2})(?:st|nd|rd|th)?,? (.+)$"#)
  private static let reMonthYear = JSRegex("^(" + monthAlt + #")\.?,? (?:de |del )?(.+)$"#)
  private static let reSeason = JSRegex(#"^(.+?) (?:of |de |del )?([0-9]{4})$"#)
  private static let reCenturyPart = JSRegex(
    #"^(early|mid|middle|late|debut|milieu|fin|principios|comienzos|inicios|mediados|finales|fines)(?=[ -]) ?-?(?:the |du |de la |del |de )?(.+)$"#)
  private static let reDecade = JSRegex(#"^(?:the )?([0-9]{3,4})'?s$"#)
  private static let reDecadeWords = [
    JSRegex(#"^(?:les )?annees ([0-9]{3,4})$"#), JSRegex(#"^(?:la )?decada de(?: los)? ([0-9]{3,4})$"#),
    JSRegex(#"^(?:los )?anos ([0-9]{3,4})$"#), JSRegex(#"^([0-9]{3,4}) ?(?:का|के) दशक$"#),
    JSRegex(#"^([0-9]{3,4}) ?(?:નો|ના) દાયકો$"#),
  ]
  private static let reTwoDigitDecade = [
    JSRegex(#"^(?:the )?'?([0-9])0'?s$"#), JSRegex(#"^(?:les )?annees ([0-9])0$"#), JSRegex(#"^(?:los (?:anos )?|anos )'?([0-9])0$"#),
  ]
  private static let reBefore = [
    JSRegex(#"^(?:before|pre-?|prior to|antes de(?:l ano)?|avant(?: l'an)?) ?(.+)$"#),
    JSRegex(#"^(.+?) ?(?:से पहले|के पहले|से पूर्व|પહેલાં|પહેલા|પૂર્વે)$"#),
  ]
  private static let reAfter = [
    JSRegex(#"^(?:after|post-?|despues de(?:l ano)?|apres(?: l'an)?) ?(.+)$"#),
    JSRegex(#"^(.+?) ?(?:के बाद|के पश्चात|પછી|બાદ)$"#),
  ]
  private static let reTrailingQuestion = JSRegex(#"^(.+?) ?\?$"#)
  private static let reBceRange = JSRegex(#"^([0-9]{1,5}) ?[-–] ?([0-9]{1,5}) ?("# + bce + ")$")
  private static let reAbbreviatedRange = JSRegex(#"^([0-9]{4}) ?[-–] ?([0-9]{1,2})$"#)
  private static let rangeForms: [JSRegex] = [
    JSRegex(#"^(?:between|entre) (.+?) (?:and|et|y|e) (.+)$"#),
    JSRegex(#"^(?:from|de|desde|du|des) (.+?) (?:to|a|à|al|au|hasta|until|till|-|–) (.+)$"#),
    JSRegex(#"^(.+?) (?:to|until|till|a|à|al|au|hasta) (.+)$"#),
    JSRegex(#"^(.+?) (?:से|થી) (.+?)(?: तक| સુધી)?$"#),
    JSRegex(#"^(.+?) ?[–/] ?(.+)$"#),
    JSRegex(#"^(.+?) - (.+)$"#),
    JSRegex(#"^([0-9]{3,4})-([0-9]{3,4})$"#),
  ]
  private static let leadingPreposition = JSRegex(#"^(?:in|en|au|during|durante|pendant) "#)
  private static let reFourDigits = JSRegex(#"(?<![0-9])[0-9]{4}(?![0-9])"#)

  // MARK: - Atoms

  /// A single year: '1931', '500 BCE', 'AD 79', '-300' (by convention).
  static func yearAtom(_ s: String, _ opts: Options) -> YearAtom? {
    if let m = reYearDigits.exec(s) {
      let y = Int(m[1]!)!
      if y == 0 {
        if opts.context.negativeYearConvention == .astronomical { return .year(0, rule: "year") }
        return .issue(issue("E_DATE_AMBIGUOUS",
                            "Year 0 does not exist in the historical calendar: set 'zero means unknown', or write '1 BCE'.", ["1 BCE"]))
      }
      return .year(y, rule: "year")
    }
    if let m = reBceYear.exec(s) {
      let n = Int(m[1]!)!
      return n >= 1 ? .year(1 - n, rule: "bce") : nil
    }
    if let m = reCeYear.exec(s) ?? reCePrefixYear.exec(s) {
      let y = Int(m[1]!)!
      return y >= 1 ? .year(y, rule: "year") : nil
    }
    if let m = reNegativeYear.exec(s) {
      let n = Int(m[1]!)!
      if n == 0 { return nil }
      return .year(opts.context.negativeYearConvention == .astronomical ? -n : 1 - n, rule: "negative_year")
    }
    return nil
  }

  static func roman(_ s: String) -> Int? {
    if !s.isEmpty, s.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) { return Int(s) }
    let values: [UInt8: Int] = [0x69: 1, 0x76: 5, 0x78: 10, 0x6C: 50, 0x63: 100]  // i v x l c
    let b = Array(s.utf8)
    guard !b.isEmpty, b.allSatisfy({ values[$0] != nil }) else { return nil }
    var n = 0
    for i in b.indices {
      let a = values[b[i]]!, next = i + 1 < b.count ? values[b[i + 1]]! : 0
      n += a < next ? -a : a
    }
    return n
  }

  /// A century → [loYear, hiYear] astronomical (popular usage: 19th century = 1800–1899).
  static func centuryAtom(_ s: String) -> (Int, Int)? {
    var n: Int? = nil
    var isBCE = false
    if let m = reCentury1.exec(s) {
      n = Int(m[1]!); isBCE = m[2] != nil
    } else if let m = reCentury2.exec(s) {
      n = roman(m[1]!); isBCE = m[2] != nil
    } else if let m = reCentury3.exec(s) {
      n = roman(m[1]!); isBCE = m[2] != nil
    } else if let m = reCentury4.exec(s) {
      n = Int(m[1]!)
    } else if let m = reCentury5.exec(s) {
      n = Int(m[1]!)
    }
    guard let n, n >= 1, n <= 30 else { return nil }
    // the 1st century CE starts at 1 CE: astronomical year 0 is 1 BCE (the reference's fix pass)
    return isBCE ? (1 - n * 100, -(n - 1) * 100) : (max(1, (n - 1) * 100), n * 100 - 1)
  }

  static func millenniumAtom(_ s: String) -> (Int, Int)? {
    var n: Int? = nil
    var isBCE = false
    if let m = reMillennium1.exec(s) {
      n = Int(m[1]!); isBCE = m[2] != nil
    } else if let m = reMillennium2.exec(s) {
      n = roman(m[1]!); isBCE = m[2] != nil
    } else if let m = reMillennium3.exec(s) {
      n = roman((m[1] ?? m[2])!); isBCE = m[3] != nil
    }
    guard let n, n >= 1, n <= 12 else { return nil }
    return isBCE ? (1 - n * 1000, -(n - 1) * 1000) : ((n - 1) * 1000, n * 1000 - 1)
  }

  // MARK: - Rules that read one date

  static func single(_ s: String, _ opts: Options, allowCirca: Bool = true) -> Reading? {
    // shaka before vikram: 'शक संवत 1850' contains 'संवत'
    if let m = reShaka.exec(s) {
      let n = Int(m[1]!)!
      return ok(span(n + 78, n + 79), "range", "derived", "shaka_samvat")
    }
    if let m = reVikram1.exec(s) ?? reVikram2.exec(s) {
      let n = Int(m[1]!)!
      return ok(span(n - 57, n - 56), "range", "derived", "vikram_samvat")
    }

    // ISO day / date-time: the stated calendar date is kept as written
    if let m = reIsoDay.exec(s) ?? reSlashDay.exec(s) {
      return dayResult(Int(m[1]!)!, Int(m[2]!)!, Int(m[3]!)!, "iso_day", opts)
    }
    // all-numeric day-first or month-first dates are not guessed
    if let m = reNumericDay.exec(s) {
      let a = Int(m[1]!)!, b = Int(m[2]!)!, y = Int(m[3]!)!
      var readings: [String] = []
      if validDay(y, b, a) { readings.append(isoString(y, b, a)) }
      if validDay(y, a, b) && a != b { readings.append(isoString(y, a, b)) }
      return .issue(readings.count == 2
        ? issue("E_DATE_AMBIGUOUS", "'\(opts.rawText)' could be day-first or month-first: write \(readings.joined(separator: " or ")).", readings)
        : issue("E_DATE_UNPARSEABLE", "'\(opts.rawText)' is not an unambiguous date: write it as YYYY-MM-DD.", readings))
    }
    if let m = reIsoMonth.exec(s), let mo = Int(m[2]!), mo >= 1 && mo <= 12 {
      let y = Int(m[1]!)!
      return ok((DayMath.dayFromYMD(y, mo, 1), DayMath.dayFromYMD(y, mo, DayMath.daysInMonth(y, mo))), "month", "stated", "month")
    }

    // named month with a day: '7 April 1931', '7 avril 1931', '7 de abril de 1931', 'April 7, 1931'
    if let m = reDayMonthYear.exec(s), case .year(let y, _)? = yearAtom(m[3]!, opts) {
      return dayResult(y, monthNames[m[2]!]!, Int(m[1]!)!, "dmy_named", opts)
    }
    if let m = reMonthDayYear.exec(s), case .year(let y, _)? = yearAtom(m[3]!, opts) {
      return dayResult(y, monthNames[m[1]!]!, Int(m[2]!)!, "dmy_named", opts)
    }
    // named month: 'April 1931', 'avril 1931', 'abril de 1931'
    if let m = reMonthYear.exec(s), case .year(let y, _)? = yearAtom(m[2]!, opts) {
      let mo = monthNames[m[1]!]!
      return ok((DayMath.dayFromYMD(y, mo, 1), DayMath.dayFromYMD(y, mo, DayMath.daysInMonth(y, mo))), "month", "stated", "month")
    }

    // seasons (northern hemisphere); winter straddles two years and is not guessed
    if let m = reSeason.exec(s) {
      for season in seasons where season.words.contains(where: { JSString.equal($0, m[1]!) }) {
        let y = Int(m[2]!)!
        if season.name == "winter" {
          let sug = ["\(y - 1)-12/\(y)-02", "\(y)-12/\(y + 1)-02"]
          return .issue(issue("E_DATE_AMBIGUOUS",
                              "'\(opts.rawText)': which winter? Write Dec \(y - 1)–Feb \(y) (\(sug[0])) or Dec \(y)–Feb \(y + 1) (\(sug[1])).", sug))
        }
        return ok((DayMath.dayFromYMD(y, season.m0, 1), DayMath.dayFromYMD(y, season.m1, DayMath.daysInMonth(y, season.m1))),
                  "range", "estimated", "season", warnings: ["W_DATE_SEASON"])
      }
    }

    // early / mid / late Nth century
    if let m = reCenturyPart.exec(s), let c = centuryAtom(m[2]!) {
      let word = m[1]!
      let part = ["early", "debut", "principios", "comienzos", "inicios"].contains(word) ? 0
        : ["mid", "middle", "milieu", "mediados"].contains(word) ? 1 : 2
      let lo = c.0 + 33 * part, hi = part == 2 ? c.1 : c.0 + 33 * (part + 1)
      return ok(span(lo, hi), "range", "stated", "century_part")
    }
    if let c = centuryAtom(s) { return ok(span(c.0, c.1), "century", "stated", "century") }
    if let c = millenniumAtom(s) { return ok(span(c.0, c.1), "millennium", "stated", "millennium") }

    // decades: '1990s', 'the 1990s', 'années 1990', 'década de 1990'; 'the 1800s' is a whole century
    if let m = reDecade.exec(s) {
      let y = Int(m[1]!)!
      if y % 10 != 0 { return nil }
      if m[1]!.utf16.count == 4 && y % 100 == 0 {
        return ok(span(y, y + 99), "century", "stated", "hundreds", warnings: ["W_AMBIGUOUS_HUNDREDS"])
      }
      return ok(span(y, y + 9), "decade", "stated", "decade")
    }
    if let m = firstMatch(reDecadeWords, s) {
      let y = Int(m[1]!)!
      if y % 10 != 0 { return nil }
      return ok(span(y, y + 9), "decade", "stated", "decade")
    }
    if let m = firstMatch(reTwoDigitDecade, s) {
      let d = Int(m[1]!)!
      guard let tdc = opts.context.twoDigitCentury else {
        let thisYear = DayMath.ymdFromDay(opts.context.now).y
        let sug = [1900, 1800, 2000].map { $0 + d * 10 }.filter { $0 <= thisYear }.map { "\($0)s" }
        return .issue(issue("E_DATE_AMBIGUOUS", "'\(opts.rawText)': which century? Set 'two-digit years → 19xx'.", sug))
      }
      let base = tdc < 100 ? tdc * 100 : tdc
      return ok(span(base + d * 10, base + d * 10 + 9), "decade", "stated", "decade_2digit")
    }

    // open ranges: 'before 1850', 'after 1850', 'antes de 1850', '1850 से पहले'
    if let m = firstMatch(reBefore, s), case .year(let y, _)? = yearAtom(m[1]!, opts) {
      return ok(span(y - opts.context.openRangeYears, y - 1), "range", "estimated", "open_range")
    }
    if let m = firstMatch(reAfter, s), case .year(let y, _)? = yearAtom(m[1]!, opts) {
      return ok(span(y + 1, y + opts.context.openRangeYears), "range", "estimated", "open_range")
    }

    // circa: a prefix word or a trailing '?'; the remainder must itself be a date
    if allowCirca {
      var rests = circaPrefixes.filter { JSString.hasPrefix(s, $0) }.map { JSString.trim(JSString.slice(s, $0.utf16.count)) }
      if let m = reTrailingQuestion.exec(s) { rests.append(m[1]!) }
      for rest in rests where !rest.isEmpty {
        guard case .ok(let inner)? = single(rest, opts, allowCirca: false) else { continue }
        if inner.precision == "year" {
          let y = DayMath.ymdFromDay(inner.lo).y, rad = opts.context.circaRadius
          return ok(span(y - rad, y + rad), "range", "estimated", "circa", approx: true)
        }
        var v = inner
        v.basis = inner.basis == "derived" ? "derived" : "estimated"
        v.approx = true
        v.rule = "circa"
        return .ok(v)
      }
    }

    switch yearAtom(s, opts) {
    case .issue(let i)?: return .issue(i)
    case .year(let y, let rule)?: return ok(span(y, y), "year", "stated", rule)
    case nil: return nil
    }
  }

  static func validDay(_ y: Int, _ mo: Int, _ d: Int) -> Bool {
    mo >= 1 && mo <= 12 && d >= 1 && d <= DayMath.daysInMonth(y, mo)
  }

  static func isoString(_ y: Int, _ mo: Int, _ d: Int) -> String {
    func pad(_ n: Int, _ w: Int) -> String { let s = String(n); return String(repeating: "0", count: max(0, w - s.count)) + s }
    let yy = y < 0 ? "-" + pad(-y, 4) : pad(y, 4)
    return "\(yy)-\(pad(mo, 2))-\(pad(d, 2))"
  }

  static func dayResult(_ y: Int, _ mo: Int, _ d: Int, _ rule: String, _ opts: Options) -> Reading {
    guard validDay(y, mo, d) else { return .issue(issue("E_DATE_INVALID", "Date \(opts.rawText) does not exist.")) }
    let day = DayMath.dayFromYMD(y, mo, d)
    return ok((day, day), "day", "stated", rule)
  }

  // MARK: - Ranges

  /// Ranges combine two single dates: '1850–1855', '1850-55', 'between 1850 and 1855', '1850/1851'.
  static func range(_ s: String, _ opts: Options) -> Reading? {
    // shared era: '500–400 BCE'
    if let m = reBceRange.exec(s) {
      return combine(single("\(m[1]!) bc", opts, allowCirca: false), single("\(m[2]!) bc", opts, allowCirca: false), opts)
    }
    // abbreviated end: '1850-55', '1850–5'
    if let m = reAbbreviatedRange.exec(s) {
      let k = m[2]!.utf16.count, start = Int(m[1]!)!
      var p = 1
      for _ in 0..<k { p *= 10 }
      let end = start - start % p + Int(m[2]!)!
      return combine(single(m[1]!, opts, allowCirca: false), single(String(end), opts, allowCirca: false), opts)
    }
    for re in rangeForms {
      guard let m = re.exec(s) else { continue }
      let a = single(m[1]!, opts), b = single(m[2]!, opts)
      if let a, let b, !a.isIssue, !b.isIssue { return combine(a, b, opts) }
    }
    return nil
  }

  static func combine(_ a: Reading?, _ b: Reading?, _ opts: Options) -> Reading? {
    guard let a, let b else { return nil }
    guard case .ok(let x) = a else { return a }
    guard case .ok(let y) = b else { return b }
    if x.lo > y.hi { return .issue(issue("E_DATE_INVALID", "Range '\(opts.rawText)' ends before it starts.")) }
    let basis = x.basis == "derived" || y.basis == "derived" ? "derived"
      : x.basis == "estimated" || y.basis == "estimated" ? "estimated" : "stated"
    var warnings: [String] = []
    for w in x.warnings + y.warnings where !warnings.contains(where: { JSString.equal($0, w) }) { warnings.append(w) }
    return ok((x.lo, y.hi), "range", basis, "range", approx: x.approx || y.approx, warnings: warnings)
  }

  // MARK: - Suggestions

  static func suggestionsFor(_ s: String, _ opts: Options) -> [String] {
    let years = reFourDigits.allMatches(s)
    var out: [String] = []
    if years.count >= 2 { out.append("\(years[0])–\(years[1])") }
    if let y = years.first {
      for (name, words) in suggestSeasons where words.contains(where: { JSString.indexOf(s, $0) >= 0 }) { out.append("\(name) \(y)") }
      for (name, mo) in monthNames where name.utf16.count >= 3 && containsWordStart(s, name) {
        out.append("\(DayMath.monthAbbr[mo - 1]) \(y)")
        break
      }
      out.append("c. \(y)")
      out.append(y)
    }
    var valid: [String] = []
    for cand in out {
      if valid.contains(where: { JSString.equal($0, cand) }) { continue }
      var o = opts
      o.raw = cand
      let p = prep(cand)
      if let r = single(p, o) ?? range(p, o), !r.isIssue { valid.append(cand) }
      if valid.count == 3 { break }
    }
    return valid
  }

  /// `new RegExp('(^|[^a-z])' + name).test(s)`.
  static func containsWordStart(_ s: String, _ name: String) -> Bool {
    let u = Array(s.utf16), p = Array(name.utf16)
    guard !p.isEmpty, u.count >= p.count else { return false }
    for i in 0...(u.count - p.count) where u[i..<(i + p.count)].elementsEqual(p) {
      if i == 0 || !(u[i - 1] >= 0x61 && u[i - 1] <= 0x7A) { return true }
    }
    return false
  }

  private static func firstMatch(_ list: [JSRegex], _ s: String) -> [String?]? {
    for re in list { if let m = re.exec(s) { return m } }
    return nil
  }
}

/// A compiled pattern with JavaScript `exec`/`test` semantics on UTF-16 strings (see DateGrammar's header).
/// NSRegularExpression is immutable and documented thread-safe, hence @unchecked Sendable.
struct JSRegex: @unchecked Sendable {
  let re: NSRegularExpression

  init(_ pattern: String) {
    do {
      re = try NSRegularExpression(pattern: pattern, options: [.useUnixLineSeparators, .dotMatchesLineSeparators])
    } catch {
      preconditionFailure("invalid built-in pattern \(pattern): \(error)")
    }
  }

  /// `re.exec(s)` of an unflagged pattern: the captures of the first match (index 0 is the whole match), nil when a
  /// group did not participate; nil when nothing matches.
  func exec(_ s: String) -> [String?]? {
    let ns = s as NSString
    guard let m = re.firstMatch(in: s, options: [], range: NSRange(location: 0, length: ns.length)) else { return nil }
    return (0..<m.numberOfRanges).map { i in
      let r = m.range(at: i)
      return r.location == NSNotFound ? nil : ns.substring(with: r)
    }
  }

  /// `s.match(/re/g)`: every match, left to right.
  func allMatches(_ s: String) -> [String] {
    let ns = s as NSString
    return re.matches(in: s, options: [], range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range) }
  }

  /// `s.replace(re, replacement)` for a non-global pattern.
  func replaceFirst(_ s: String, with replacement: String) -> String {
    let ns = s as NSString
    guard let m = re.firstMatch(in: s, options: [], range: NSRange(location: 0, length: ns.length)) else { return s }
    return ns.replacingCharacters(in: m.range, with: replacement)
  }
}
