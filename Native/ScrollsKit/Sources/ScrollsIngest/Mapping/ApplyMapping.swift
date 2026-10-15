// OWNER: N1
// Port of server/ingest/mapping.mjs, per-record part (SPEC §5.2, §5.3, §5.5): one RawRecord through a normalized
// mapping → one CanonicalDocument, the relationships the record states (documented citations and relations with a
// locator into the stored original, or proposed ones), and the issues of the row in the reference's words. Dates are
// parsed here with the mapping's options (`parseDateValue`): a value that does not parse becomes an explicit
// 'unparsed' assertion (raw kept, undated) and its issue says "row imported as undated". A start and an end date
// combine into one interval; a precision column can only widen a date, never narrow it.

import Foundation
import ScrollsContracts
import ScrollsCore

extension MappingRules {
  // MARK: values

  /// `kindOf(v)` of the type messages.
  static func kindOf(_ v: JSValue) -> String {
    switch v {
    case .null: "empty"
    case .array: "a list"
    case .object: "an object"
    case .number: "a number"
    case .bool: "true/false"
    case .string: "text"
    }
  }

  /// `isBlank(v)`: undefined, null, whitespace-only text or an empty list.
  static func isBlank(_ v: JSValue?) -> Bool {
    switch v {
    case nil, .null?: true
    case .string(let s)?: JSString.trim(s).isEmpty
    case .array(let a)?: a.isEmpty
    default: false
    }
  }

  /// `rowRef(line)`: "Row 12" or "The record".
  static func rowRef(_ line: Int?) -> String { line.map { "Row \($0)" } ?? "The record" }

  /// `/[\p{L}\p{N}\p{So}]/u.test(s)`.
  static func hasLetterNumberOrSymbol(_ s: String) -> Bool {
    s.unicodeScalars.contains { !TokenClassTable.classes($0.value).isDisjoint(with: [.letter, .number, .otherSymbol]) }
  }

  /// The parse options of a target (`{...dateOpts, ...dateOptsByTarget[t]}`) as the grammar's context.
  static func dateContext(_ o: [String: JSValue], now: Date) -> DateContext {
    var c = DateContext(now: DayMath.day(of: now))
    if case .number(let n)? = o["circaRadius"], n.isFinite { c.circaRadius = Int(n) }
    if case .number(let n)? = o["openRangeYears"], n.isFinite { c.openRangeYears = Int(n) }
    switch o["twoDigitCentury"] {
    case .number(let n)? where n.isFinite: c.twoDigitCentury = Int(n)
    default: c.twoDigitCentury = nil
    }
    c.zeroIsUnknown = isTruthy(o["zeroIsUnknown"])
    if case .string(let s)? = o["negativeYearConvention"], let v = NegativeYearConvention(rawValue: s) { c.negativeYearConvention = v }
    return c
  }

  // MARK: dates

  /// `unparsed(raw)`: kept with its raw value, undated (rule 'unparsed').
  static func unparsed(_ raw: String) -> DateParse {
    DateParse(loDay: nil, hiDay: nil, yLo: nil, yHi: nil, precision: "unknown", basis: "unknown", approx: false, rule: "unparsed",
              raw: raw, label: "undated", warnings: [])
  }

  /// A parse and its note (`{...parsed, note}` of the reference; the note travels on the assertion, not the parse).
  public struct ParsedDate: Sendable {
    public var parsed: DateParse?
    public var note: String?
  }

  /// `parseDateValue(raw, opts, {line, column, label, now})`: one date value with the mapping's options; issues name
  /// the row and the column.
  public static func parseDateValue(_ raw: String, _ opts: [String: JSValue], line: Int?, column: String?, label: String,
                                    now: Date) -> (parsed: ParsedDate, issues: [Issue]) {
    var issues: [Issue] = []
    let s = JSString.trim(raw)
    if s.isEmpty { return (ParsedDate(parsed: nil, note: nil), issues) }
    let ctx = dateContext(opts, now: now)
    let r = DateGrammar.parse(s, context: ctx)
    let who = "\(rowRef(line)) \(label)"
    let excerpt = JSString.slice(s, 0, 200)
    func issue(_ code: String, _ severity: String, _ message: String, _ suggestion: String) -> Issue {
      Issue(code: code, severity: severity, line: line, col: nil, field: column, valueExcerpt: excerpt, message: message, suggestion: suggestion)
    }
    if let ri = r.issue {
      let readings = ri.suggestions.map { x -> String in
        let p = DateGrammar.parse(x, context: ctx)
        return p.issue != nil || p.label.isEmpty || JSString.equal(p.label, x) ? "'\(x)'" : "'\(x)' (\(p.label))"
      }
      let code = ri.code
      let message: String, suggestion: String
      if code == "E_DATE_INVALID" {
        message = "\(who) \(s) does not exist; row imported as undated."
        suggestion = readings.isEmpty ? "Check the day and the month (and that a range does not end before it starts)."
          : "Try \(readings.joined(separator: " or "))."
      } else if code == "E_DATE_AMBIGUOUS" {
        let prefix = "'\(s)': "
        let detail = JSString.hasPrefix(ri.message, prefix) ? JSString.slice(ri.message, prefix.utf16.count) : ri.message
        let trimmed = JSString.hasSuffix(detail, ".") ? JSString.slice(detail, 0, detail.utf16.count - 1) : detail
        message = "\(who) '\(s)': \(trimmed). Row imported as undated."
        suggestion = ri.message.contains("two-digit")
          ? "Set 'two-digit years → 19xx' (or 18xx/20xx) in the date options, or write the full decade such as 1990s."
          : readings.isEmpty ? "Write the date unambiguously (YYYY-MM-DD)." : "Write it unambiguously, for example \(readings.joined(separator: " or "))."
      } else {
        message = "\(who) '\(s)' was not recognised; row imported as undated."
        suggestion = readings.isEmpty ? "Write the date as YYYY, YYYY-MM-DD, \"c. YYYY\" or a range such as 1850–1855."
          : "Try \(readings.joined(separator: " or "))."
      }
      issues.append(issue(code, "warning", message, suggestion))
      return (ParsedDate(parsed: unparsed(s), note: "\(code): \(ri.message)"), issues)
    }
    for w in r.warnings {
      switch w {
      case "W_DATE_FUTURE":
        issues.append(issue(w, "info", "\(who) '\(s)' is after the import time; shown on the Scheduled shelf.",
                            "If this is a plan or an announcement, nothing to do; otherwise correct the date."))
      case "W_AMBIGUOUS_HUNDREDS":
        let lo = r.yLo.map { Int($0) } ?? 0
        issues.append(issue(w, "warning", "\(who) '\(s)' was read as the whole century \(r.label).",
                            "Write \(lo)–\(lo + 9) if the decade was meant."))
      case "W_DATE_SEASON":
        issues.append(issue(w, "info", "\(who) '\(s)' was read as \(r.label) (northern-hemisphere season).", "Give the month if it is known."))
      default:
        issues.append(issue(w, "info", "\(who) '\(s)': \(w).", "See the date grammar in Docs/IMPORT-SCHEMA.md."))
      }
    }
    var p = r
    p.warnings = []
    return (ParsedDate(parsed: p, note: nil), issues)
  }

  static let basisRank: [String: Int] = ["stated": 0, "estimated": 1, "derived": 2, "period": 3, "announced": 4, "unknown": 5]
  static func worseBasis(_ a: String, _ b: String) -> String { (basisRank[a] ?? 99) >= (basisRank[b] ?? 99) ? a : b }

  /// `combineDates(a, b, raw, now)`: a start and an end date as one interval.
  static func combineDates(_ a: DateParse, _ b: DateParse, raw: String, now: Date) -> DateParse {
    let yearish: Set<String> = ["year", "decade", "century", "millennium"]
    var basis = worseBasis(a.basis == "announced" ? "stated" : a.basis, b.basis == "announced" ? "stated" : b.basis)
    let approx = a.approx || b.approx
    var p: DateParse
    if yearish.contains(a.precision) && yearish.contains(b.precision), let lo = a.yLo, let hi = b.yHi,
       let x = try? DateGrammar.fromInterval(Int(lo), Int(hi), basis: basis, rule: "range", raw: raw, approx: approx) {
      p = x
    } else if let lo = a.loDay, let hi = b.hiDay,
              let x = try? DateGrammar.fromDayInterval(Int(lo), Int(hi), precision: lo == hi ? "day" : "range", basis: basis, rule: "range",
                                                       raw: raw, approx: approx) {
      p = x
    } else {
      p = unparsed(raw)
    }
    if let lo = p.loDay, Int(lo) > DayMath.day(of: now) {
      basis = "announced"
      p.basis = basis
      p.rule = "range+future"
    }
    p.warnings = []
    return p
  }

  /// `widenTo(p, want)`: a date widened to a stated precision; never narrowed (that would invent precision).
  static func widenTo(_ p: DateParse, _ want: String) -> (parsed: DateParse, ok: Bool, reason: String?) {
    guard let loDay = p.loDay, let hiDay = p.hiDay else { return (p, true, nil) }
    let w = JSString.toLowerCase(JSString.trim(want))
    guard precisionOrder.contains(w) else {
      return (p, false, "'\(want)' is not one of \(precisionOrder.joined(separator: ", "))")
    }
    let lo = Int(p.yLo ?? 0), hi = Int(p.yHi ?? 0)
    let spans = "the date spans \(p.label)"
    var out: DateParse
    if w == "day" { return loDay == hiDay ? (p, true, nil) : (p, false, spans) }
    if w == "month" {
      let a = DayMath.ymdFromDay(Int(loDay))
      let first = DayMath.dayFromYMD(a.y, a.m, 1), last = DayMath.dayFromYMD(a.y, a.m, DayMath.daysInMonth(a.y, a.m))
      if Int(hiDay) > last { return (p, false, spans) }
      guard let x = try? DateGrammar.fromDayInterval(first, last, precision: "month", basis: p.basis, rule: "\(p.rule)+precision",
                                                     raw: p.raw, approx: p.approx) else { return (p, false, spans) }
      out = x
    } else {
      let width = ["year": 1, "decade": 10, "century": 100, "millennium": 1000][w]!
      let b0 = DayMath.floorDiv(lo, width) * width
      if hi > b0 + width - 1 { return (p, false, spans) }
      guard let x = try? DateGrammar.fromInterval(b0, b0 + width - 1, precision: w, basis: p.basis, rule: "\(p.rule)+precision",
                                                  raw: p.raw, approx: p.approx) else { return (p, false, spans) }
      out = x
    }
    out.warnings = []
    return (out, true, nil)
  }

  // MARK: one record

  /// `applyMapping(record, mapping, ctx)`: one source record → a CanonicalDocument (or a rejection) and the
  /// relationships it states.
  public static func apply(_ record: RawRecord, _ mapping: Mapping, _ ctx: MappingContext) -> Mapped {
    var issues: [Issue] = []
    var rels: [CanonicalRelationship] = []
    let line = record.line
    let now = ctx.now
    let data = record.data ?? JSObject()
    func spec(_ t: String) -> FieldSpec? { mapping.field(t) }
    func columnOf(_ t: String) -> String? { spec(t)?.from.map(JSText.string) }
    var optsByTarget: [String: [String: JSValue]] = [:]

    func value(_ target: String) -> JSValue? {
      guard let s = spec(target) else { return nil }
      let raw = s.constValue ?? sourceValue(data, s.from)
      var opts = DateOpts(isDate: dateTargets.contains(target))
      let v = run(raw, s.transforms, &opts)
      optsByTarget[target] = opts.values
      return v
    }
    func typeIssue(_ target: String, _ v: JSValue, _ expected: String) {
      let col = columnOf(target) ?? target
      issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: line, col: nil, field: col,
        valueExcerpt: JSString.slice(JSText.stringify(v), 0, 200),
        message: "\(rowRef(line)) '\(col)' is \(kindOf(v)); expected \(expected). The field was ignored.",
        suggestion: target == "cites" ? "Give the cited ids as a list, or as text separated by \";\"."
          : "Map '\(target)' to a column that holds \(expected), or add a transform (join, split, regex_extract)."))
    }
    func str(_ target: String, max: Int = maxString) -> String? {
      guard let v = value(target), !isBlank(v) else { return nil }
      switch v {
      case .string(let s): return s.utf16.count > max ? JSString.slice(s, 0, max) : s
      case .number, .bool: return JSText.string(v)
      case .array(let a) where a.allSatisfy({ if case .array = $0 { false } else if case .object = $0 { false } else { true } }):
        let s = a.filter { !isBlank($0) }.map(JSText.string).joined(separator: "; ")
        return s.isEmpty ? nil : s
      default:
        typeIssue(target, v, "text")
        return nil
      }
    }
    func list(_ target: String) -> [String] {
      guard let v = value(target), !isBlank(v) else { return [] }
      let hasSplit = spec(target)?.transforms.contains { $0.op == "split" || $0.op == "join" } ?? false
      switch v {
      case .string(let s):
        let parts = hasSplit ? [s] : splitAny(s, [0x3B, 0x7C])
        return parts.map(JSString.trim).filter { !$0.isEmpty }
      case .number: return [JSText.string(v)]
      case .array(let a) where a.allSatisfy({ switch $0 { case .null, .string, .number: true; default: false } }):
        return a.filter { !isBlank($0) }.map { JSString.trim(JSText.string($0)) }
      default:
        typeIssue(target, v, target == "cites" ? "a list of ids" : "a list of values")
        return []
      }
    }

    // ext_id
    var extID = str("ext_id", max: 100_000).map(JSString.trim)
    if let e = extID, e.utf16.count > maxID {
      issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: line, col: nil, field: columnOf("ext_id"),
        valueExcerpt: JSString.slice(e, 0, 200),
        message: "\(rowRef(line)) id is \(e.utf16.count) characters long (limit \(maxID)); a generated id was used.",
        suggestion: "Map a shorter, unique id column."))
      extID = nil
    }
    let sha8 = JSString.slice(ctx.sha256, 0, 8)
    let generatedID = ctx.format == "txt" || ctx.format == "md"
      ? "\(IDs.slug(TextFiles.fileStem(ctx.fileName), max: 40))-\(sha8)" : "\(sha8)#\(record.ordinal)"
    if extID == nil {
      if spec("ext_id") != nil {
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: line, col: nil, field: columnOf("ext_id"), valueExcerpt: nil,
          message: "\(rowRef(line)) has no id; it was given the id '\(generatedID)'.",
          suggestion: "Give every row an id if other rows cite it."))
      }
      extID = generatedID
    }
    let ext = extID!

    // plain metadata
    let kindRaw = JSString.toLowerCase(JSString.trim(str("kind", max: 40) ?? ctx.defaultKind ?? "document"))
    var doc = CanonicalDocument(extId: ext, kind: kindRaw.isEmpty ? "document" : kindRaw, dates: [], originalMeta: .null)
    if let v = str("title") { doc.title = v }
    if let v = str("author") { doc.author = v }
    if let v = str("genre") { doc.genre = v }
    if let v = str("community") { doc.community = v }
    if let v = str("culture") { doc.culture = v }
    if let v = str("field") { doc.field = v }
    if let v = str("source_url") { doc.sourceUrl = v }
    if let v = str("license") { doc.license = v }

    // language
    if let langRaw = str("language", max: 64) {
      if let code = normalizeLang(langRaw) {
        doc.langDeclared = code
      } else {
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: line, col: nil, field: columnOf("language"), valueExcerpt: langRaw,
          message: "\(rowRef(line)) language '\(langRaw)' is not a language name or code; the language will be detected from the text.",
          suggestion: "Use a code such as en, fr, es, hi or gu, or add a map transform ({\"\(langRaw)\": \"…\"})."))
      }
    }

    // text
    var textSpec: CanonicalText?
    if let t = spec("text") {
      let raw = t.constValue ?? sourceValue(data, t.from)
      var fromBody = false
      if record.document != nil, case .string(let f)? = t.from, JSString.equal(f, "text"), t.transforms.isEmpty { fromBody = true }
      if fromBody, let d = record.document {
        let body = JSString.slice(d.original, d.bodyStart, d.bodyEnd)
        if hasLetterNumberOrSymbol(body) {
          textSpec = CanonicalText(original: d.original, decoder: ctx.decoder, bodyStart: d.bodyStart, bodyEnd: d.bodyEnd,
                                   regions: d.regions.isEmpty ? nil : d.regions, mode: mapping.lineMode ? "verse" : d.mode)
        }
      } else {
        var none = DateOpts()
        var v = run(raw, t.transforms, &none)
        var decoder = ctx.decoder
        if case .array(let a)? = v, a.allSatisfy({ switch $0 { case .string, .number: true; default: false } }) {
          v = .string(a.map(JSText.string).joined(separator: "\n\n"))
        }
        if let j = t.transforms.first(where: { $0.op == "join" }), case .join(let arg) = j, JSString.equal(arg, "\u{0C}") {
          decoder = "pages-joined-ff"
        }
        if case .number? = v { v = .string(JSText.string(v!)) }
        if case .string(let s)? = v {
          if hasLetterNumberOrSymbol(s) { textSpec = CanonicalText(original: s, decoder: decoder, mode: mapping.lineMode ? "verse" : "auto") }
        } else if let v, !isBlank(v) {
          typeIssue("text", v, "text")
        }
      }
    }
    if let ts = textSpec {
      let units = Array(ts.original.utf16)
      let chars = units.count
      let bytes = chars * 3 > maxFieldBytes ? Decode.utf8Length(units) : chars
      if bytes > maxFieldBytes {
        let mb = JSNumber.toFixed(Double(bytes) / 1_048_576, bytes >= 10 * 1_048_576 ? 0 : 1)
        let reject = Issue(code: "E_ROW_TOO_LARGE", severity: "rejected", line: line, col: nil, field: columnOf("text") ?? "text",
          valueExcerpt: JSString.slice(ts.original, 0, 120), message: "\(rowRef(line)) text is \(mb) MB (limit 20 MB).",
          suggestion: "Split the text into parts under 20 MB (for example one row per chapter), or import the parts as separate TXT files.")
        return Mapped(doc: nil, extID: ext, rels: rels, issues: issues, reject: reject, stats: [:])
      }
      doc.text = ts
    }

    // dates
    func dateRaw(_ t: String) -> String? {
      guard let v = value(t), !isBlank(v) else { return nil }
      switch v {
      case .string(let s): return s
      case .number: return JSText.string(v)
      default:
        typeIssue(t, v, "a date")
        return nil
      }
    }
    func optsFor(_ t: String) -> [String: JSValue] { optsByTarget[t] ?? [:] }
    let rawDate = spec("date") != nil ? dateRaw("date") : nil
    let rawEnd = spec("date_end") != nil ? dateRaw("date_end") : nil
    var chrono: (parsed: DateParse?, raw: String, note: String?)?
    if let rawDate {
      let a = parseDateValue(rawDate, optsFor("date"), line: line, column: columnOf("date") ?? "date", label: "date", now: now)
      issues += a.issues
      chrono = (a.parsed.parsed, rawDate, a.parsed.note)
      if let rawEnd, let ap = a.parsed.parsed, let aLo = ap.loDay {
        let b = parseDateValue(rawEnd, optsFor("date_end"), line: line, column: columnOf("date_end") ?? "date_end", label: "end date", now: now)
        issues += b.issues.filter { $0.code != "W_DATE_FUTURE" }
        if let bp = b.parsed.parsed, let bHi = bp.hiDay, bp.loDay != nil {
          let raw = "\(rawDate) – \(rawEnd)"
          if bHi < aLo {
            issues.append(Issue(code: "E_DATE_INVALID", severity: "warning", line: line, col: nil, field: columnOf("date_end"), valueExcerpt: raw,
              message: "\(rowRef(line)) date range \(raw) ends before it starts; row imported as undated.",
              suggestion: "Swap the start and end dates, or correct the one that is wrong."))
            let note = "E_DATE_INVALID: the range ends before it starts"
            chrono = (unparsed(raw), raw, note)
          } else {
            let c = combineDates(ap, bp, raw: raw, now: now)
            chrono = (c, raw, nil)
            if c.basis == "announced" && !issues.contains(where: { $0.code == "W_DATE_FUTURE" }) {
              issues.append(Issue(code: "W_DATE_FUTURE", severity: "info", line: line, col: nil, field: columnOf("date"), valueExcerpt: raw,
                message: "\(rowRef(line)) date '\(raw)' is after the import time; shown on the Scheduled shelf.",
                suggestion: "If this is a plan or an announcement, nothing to do; otherwise correct the date."))
            }
          }
        }
      }
    } else if let rawEnd {
      issues.append(Issue(code: "E_DATE_UNPARSEABLE", severity: "warning", line: line, col: nil, field: columnOf("date_end"), valueExcerpt: rawEnd,
        message: "\(rowRef(line)) has an end date but no start date; row imported as undated.",
        suggestion: "Map the start date too, or map this column as the date."))
    }
    if let c = chrono, let p = c.parsed, p.loDay != nil, spec("date_precision") != nil, let want = str("date_precision", max: 32) {
      let w = widenTo(p, want)
      if w.ok {
        chrono!.parsed = w.parsed
      } else {
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: line, col: nil, field: columnOf("date_precision"), valueExcerpt: want,
          message: "\(rowRef(line)) precision '\(want)' was not applied: \(w.reason ?? "").",
          suggestion: "A precision override can only widen a date (to \(precisionOrder.joined(separator: ", "))); it never narrows one."))
      }
    }
    var stats: [String: String?] = ["date": nil, "referenced_date": nil]
    let assertedBy = "import:\(ctx.batchID.map { String($0) } ?? "dry-run")"
    if let c = chrono {
      stats["date"] = .some(c.parsed?.loDay != nil ? "parsed" : "unparsed")
      doc.dates.append(CanonicalDate(role: "publication", raw: c.raw, parsed: c.parsed, assertedBy: assertedBy, isChronology: true, note: c.note))
    }
    if spec("referenced_date") != nil, let r = dateRaw("referenced_date") {
      let p = parseDateValue(r, optsFor("referenced_date"), line: line, column: columnOf("referenced_date") ?? "referenced_date",
                             label: "referenced date", now: now)
      issues += p.issues.filter { $0.code != "W_DATE_FUTURE" }
      stats["referenced_date"] = .some(p.parsed.parsed?.loDay != nil ? "parsed" : "unparsed")
      doc.dates.append(CanonicalDate(role: "referenced", raw: r, parsed: p.parsed.parsed, assertedBy: assertedBy, isChronology: false,
                                     note: p.parsed.note ?? "what the text is about, not when it was written"))
    }

    // tags, citations, relations
    var seenTags = Set<UnitKey>()
    var tags: [String] = []
    for t in list("tags").map({ JSString.slice($0, 0, 200) }) where seenTags.insert(UnitKey(t)).inserted { tags.append(t) }
    if !tags.isEmpty {
      doc.tags = tags.map { CanonicalTag(scheme: "keyword", value: $0, provenance: "documented_category", method: "import:\(ctx.fileName)") }
    }
    let locator = "sha256:\(ctx.sha256)#line=\(line ?? record.ordinal)"
    var seenCites = Set<UnitKey>()
    for target in list("cites") where seenCites.insert(UnitKey(target)).inserted {
      if JSString.equal(target, ext) {
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: line, col: nil, field: columnOf("cites"), valueExcerpt: target,
          message: "\(rowRef(line)) cites its own id '\(target)'; that citation was ignored.", suggestion: "Check the id in the cites column."))
        continue
      }
      rels.append(statedRelationship("explicit_citation", ext, target, "documented", ctx, locator))
    }
    if spec("relations") != nil {
      for r in relationsOf(value("relations"), line: line, column: columnOf("relations"), &issues) where !JSString.equal(r.target, ext) {
        rels.append(statedRelationship(r.type, ext, r.target, r.evidence, ctx, locator, collection: r.collection))
      }
    }

    // original_meta: the verbatim record (bulk text replaced by a pointer) + mapped meta.* + notes
    var recordCopy = data
    if let t = spec("text"), let from = t.from, doc.text != nil {
      let key = JSText.string(from)
      if case .string(let s)? = recordCopy[key] {
        recordCopy[key] = .object(JSObject([("$text", .string("document text")), ("chars", .number(Double(s.utf16.count)))]))
      }
    }
    var meta = JSObject([("file", .string(ctx.fileName)), ("line", line.map { .number(Double($0)) } ?? .null), ("record", .object(recordCopy))])
    if let k = record.headerKind { meta["header_kind"] = .string(k) }
    if let notes = str("notes", max: 100_000) { meta["notes"] = .string(notes) }
    let metaTargets = mapping.fields.map(\.target).filter { $0.hasPrefix("meta.") }
    if !metaTargets.isEmpty {
      meta["mapped"] = .object(JSObject(metaTargets.map { (String($0.dropFirst(5)), value($0) ?? .null) }))
    }
    if spec("collection") != nil, let c = str("collection") { meta["collection_value"] = .string(c) }
    doc.originalMeta = JSValue.object(meta).json
    if let br = ctx.byteRange { doc.sourceFile = SourceFileSpan(sha256: ctx.sha256, byteStart: br.start, byteEnd: br.end) }

    if doc.text == nil && doc.title == nil {
      let reject = Issue(code: "E_MISSING_TEXT", severity: "rejected", line: line, col: nil, field: columnOf("text"), valueExcerpt: ext,
        message: "\(rowRef(line)) has no text and no title.",
        suggestion: spec("text") != nil ? "Map a title as well (rows without text are kept as metadata with their title), or fill in the text."
          : "Map a text column or a title, or allow metadata-only rows by mapping a title.")
      return Mapped(doc: nil, extID: ext, rels: [], issues: issues, reject: reject, stats: stats)
    }
    return Mapped(doc: doc, extID: ext, rels: rels, issues: issues, reject: nil, stats: stats)
  }

  /// `s.split(/[;|]/)` (any of the given code units).
  static func splitAny(_ s: String, _ seps: Set<UInt16>) -> [String] {
    var out: [String] = []
    var cur: [UInt16] = []
    for u in s.utf16 {
      if seps.contains(u) {
        out.append(String(decoding: cur, as: UTF16.self))
        cur = []
      } else {
        cur.append(u)
      }
    }
    out.append(String(decoding: cur, as: UTF16.self))
    return out
  }

  /// `statedRelationship(relType, srcExt, dstExt, evidence, ctx, locator, collection)`: documented (with a locator into
  /// the stored original) or proposed.
  static func statedRelationship(_ relType: String, _ src: String, _ dst: String, _ evidence: String, _ ctx: MappingContext,
                                 _ locator: String, collection: String? = nil) -> CanonicalRelationship {
    let dstEnd = CanonicalEndpoint(collection: collection, extId: dst)
    if evidence == "documented" {
      return CanonicalRelationship(src: CanonicalEndpoint(extId: src), dst: dstEnd, relType: relType, evidenceStatus: "documented",
        origin: "source_dataset", sourceDataset: "your import: \(ctx.fileName)", sourceLocator: locator, provenanceQuality: "complete",
        createdBy: "import:\(ctx.batchID.map { String($0) } ?? "dry-run")", provenanceNote: "as stated in your file")
    }
    return CanonicalRelationship(src: CanonicalEndpoint(extId: src), dst: dstEnd, relType: relType, evidenceStatus: "proposed",
      origin: "human", createdBy: "human:import of \(ctx.fileName)", provenanceNote: "proposed in your file (\(locator))")
  }

  /// One relation of a record, as `relationsOf` returns it.
  public struct StatedRelation: Sendable, Equatable {
    public var type: String
    public var target: String
    public var evidence: String
    public var collection: String?
  }

  /// `relationsOf(v, line, column, issues)`: a list of `{type, target|target_ext_id, evidence?, collection?}` objects, or
  /// "type:target[:evidence]" items separated by ';'. Unknown types are reported and skipped.
  public static func relationsOf(_ v: JSValue?, line: Int?, column: String?, _ issues: inout [Issue]) -> [StatedRelation] {
    guard let v, !isBlank(v) else { return [] }
    // an item: its properties in the reference's literal order (undefined members are left out of JSON.stringify)
    struct Item {
      /// `{bad: x}` for an item that is not an object.
      var bad: JSValue?
      var isBad = false
      var type: JSValue?
      var target: JSValue?
      var evidence: JSValue?
      var collection: JSValue?
      var hasCollection = false
      var json: String {
        // JSON.stringify(it.bad ?? it)
        if isBad { return bad.map { $0.isNull ? "{\"bad\":null}" : JSText.stringify($0) } ?? "{}" }
        var o = JSObject()
        if let type { o["type"] = type }
        if let target { o["target"] = target }
        if let evidence { o["evidence"] = evidence }
        if hasCollection { o["collection"] = collection ?? .null }
        return JSText.stringify(.object(o))
      }
    }
    func nn(_ x: JSValue?) -> JSValue? { if let x, !x.isNull { x } else { nil } }   // `a ?? b` treats null as missing
    var items: [Item] = []
    switch v {
    case .string(let s):
      items = splitAny(s, [0x3B, 0x7C]).map(JSString.trim).filter { !$0.isEmpty }.map { s in
        var parts = JSString.split(s, ":")
        let last = JSString.toLowerCase(JSString.trim(parts[parts.count - 1]))
        var evidence: JSValue?
        if parts.count >= 3 && (last == "documented" || last == "proposed") {
          evidence = .string(JSString.toLowerCase(JSString.trim(parts.removeLast())))
        }
        let type = JSString.trim(parts.removeFirst())
        return Item(type: .string(type), target: .string(JSString.trim(parts.joined(separator: ":"))), evidence: evidence)
      }
    case .array(let a):
      items = a.map { x in
        guard case .object(let o) = x else {
          if case .array = x { return Item(type: nil, target: nil, evidence: nil, collection: .null, hasCollection: true) }
          return Item(bad: x, isBad: true)
        }
        return Item(type: nn(o["type"]) ?? o["rel_type"], target: nn(o["target_ext_id"]) ?? nn(o["target"]) ?? o["ext_id"],
                    evidence: nn(o["evidence"]) ?? o["evidence_status"], collection: nn(o["collection"]) ?? .null, hasCollection: true)
      }
    case .object(let o):
      items = [Item(type: nn(o["type"]) ?? o["rel_type"], target: nn(o["target_ext_id"]) ?? o["target"], evidence: o["evidence"],
                    collection: nn(o["collection"]) ?? .null, hasCollection: true)]
    default: break
    }
    func truthy(_ x: JSValue?) -> Bool { isTruthy(x) }
    var out: [StatedRelation] = []
    for it in items {
      let targetBlank: Bool = {
        guard let t = it.target, !t.isNull else { return true }
        return JSString.trim(JSText.string(t)).isEmpty
      }()
      if it.isBad || !truthy(it.type) || targetBlank {
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: line, col: nil, field: column,
          valueExcerpt: JSString.slice(it.json, 0, 200),
          message: "\(rowRef(line)) has a relation without a type or a target; it was ignored.",
          suggestion: "Write relations as {\"type\": \"samples\", \"target\": \"<id>\"} or as \"samples:<id>\" separated by \";\"."))
        continue
      }
      let typeText = JSText.string(it.type!)
      let type = collapseSpaceDash(JSString.toLowerCase(JSString.trim(typeText)))
      guard let rt = Vocab.relTypeByCode[type] else {
        let known = Vocab.relTypeByCode.keys.filter { !proposedOnlyFamilies.contains(Vocab.relTypeByCode[$0]!.family) }
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: line, col: nil, field: column,
          valueExcerpt: JSString.slice(typeText, 0, 200),
          message: "\(rowRef(line)) relation type '\(typeText)' is not known; that relation was ignored.",
          suggestion: "Use one of: \(known.joined(separator: ", "))."))
        continue
      }
      var evidence: String
      switch it.evidence {
      case nil, .null?, .string("")?: evidence = "documented"
      case let e?: evidence = JSString.toLowerCase(JSText.string(e))
      }
      if evidence != "documented" && evidence != "proposed" {
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "warning", line: line, col: nil, field: column,
          valueExcerpt: it.evidence.map(JSText.string),
          message: "\(rowRef(line)) relation evidence '\(it.evidence.map(JSText.string) ?? "undefined")' is not 'documented' or 'proposed'; it was read as proposed.",
          suggestion: "A file can state a link (documented) or suggest one (proposed); 'computed' links come only from Scrolls' own analysis runs."))
        evidence = "proposed"
      }
      if evidence == "documented" && proposedOnlyFamilies.contains(rt.family) {
        issues.append(Issue(code: "E_FIELD_TYPE", severity: "info", line: line, col: nil, field: column, valueExcerpt: type,
          message: "\(rowRef(line)) relation '\(type)' is a similarity type; it was recorded as proposed, not documented.",
          suggestion: "Similarity never establishes a documented link; state the documented relation (cites, samples, adaptation_of, …) if your source records one."))
        evidence = "proposed"
      }
      out.append(StatedRelation(type: type, target: JSString.trim(JSText.string(it.target!)), evidence: evidence,
                                collection: truthy(it.collection) ? JSText.string(it.collection!) : nil))
    }
    return out
  }

  /// `.replace(/[\s-]+/g, '_')` with JavaScript's \s.
  static func collapseSpaceDash(_ s: String) -> String {
    var out: [UInt16] = []
    var inRun = false
    for u in s.utf16 {
      if u == 0x2D || JSString.isWhitespace(u) {
        if !inRun { out.append(0x5F); inRun = true }
      } else {
        out.append(u)
        inRun = false
      }
    }
    return String(decoding: out, as: UTF16.self)
  }
}
