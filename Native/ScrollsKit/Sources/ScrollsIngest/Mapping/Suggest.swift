// OWNER: N1
// Port of server/ingest/suggest.mjs (SPEC §5.2 step 2): mapping suggestions from header synonyms and value sniffing.
// A column is inferred as text | date | number | id | url | lang | list from its sampled values; the suggestion fills
// each canonical target from header synonyms first, value sniffing second (> 80 % of values parse as dates → date; the
// longest average string → text). Every suggested field carries the reason it was chosen, which the import summary
// reports as a mapping decision. Values are JavaScript values (nil = undefined: a record without that key).

import Foundation
import ScrollsContracts
import ScrollsCore

/// What `inferColumn` finds.
public struct ColumnInference: Sendable, Equatable {
  public var inferred: String
  public var dateShare: Double
  public var avgLength: Double
  public var unique: Bool
  public var distinct: Double
  public var listSep: String?
  public var filled: Int
}

/// A column handed to `suggestMapping`: its name, the 5 samples shown and every sampled value.
public struct SuggestColumn: Sendable {
  public var name: String
  public var samples: [JSValue?]
  public var values: [JSValue?]?
  public init(name: String, samples: [JSValue?], values: [JSValue?]?) {
    self.name = name
    self.samples = samples
    self.values = values
  }
}

/// Mapping suggestions (suggest.mjs).
public enum Suggest {
  static let dateShareMin = 0.8

  /// Header synonyms per target, in the reference's order (folded: lower case, accents dropped, separators → '_').
  public static let synonyms: [(target: String, names: [String])] = [
    ("ext_id", ["id", "ext_id", "identifier", "key", "doc_id", "document_id", "record_id", "uid", "uuid", "slug", "no", "nr", "number", "#", "item_id"]),
    ("title", ["title", "name", "headline", "heading", "titulo", "titre", "शीर्षक", "नाम", "શીર્ષક", "નામ", "work", "work_title"]),
    ("text", ["text", "body", "content", "contents", "lyrics_excerpt", "lyrics", "passage", "transcript", "full_text", "fulltext",
              "texto", "contenu", "texte", "पाठ", "सामग्री", "લખાણ", "સામગ્રી", "pages", "message", "post"]),
    ("author", ["author", "authors", "creator", "by", "writer", "artist", "speaker", "maker", "autor", "auteur", "लेखक", "લેખક", "poet", "composer"]),
    ("date", ["date", "year", "published", "issued", "pub_date", "publication_date", "date_published", "fecha", "तारीख", "તારીખ",
              "created", "creation_date", "released", "release_date", "ano", "annee", "when", "datum", "start_date", "year_start", "from"]),
    ("date_end", ["date_end", "end_date", "year_end", "end", "until", "to", "end_year"]),
    ("date_precision", ["precision", "date_precision"]),
    ("referenced_date", ["referenced_date", "about_date", "subject_date", "setting_date", "period", "refers_to", "era"]),
    ("language", ["language", "lang", "idioma", "langue", "भाषा", "ભાષા", "locale", "lang_code", "language_code"]),
    ("kind", ["kind", "type", "medium", "document_type", "doc_type", "form"]),
    ("genre", ["genre", "genero", "category", "categorie"]),
    ("community", ["community", "scene", "group", "comunidad", "communaute", "audience"]),
    ("culture", ["culture", "country", "country_of_origin", "pais", "pays", "origin", "nation"]),
    ("field", ["field", "discipline", "subject_area", "domain"]),
    ("source_url", ["url", "link", "source_url", "href", "uri", "source", "permalink", "web"]),
    ("license", ["license", "licence", "rights", "licencia", "copyright"]),
    ("cites", ["cites", "refs", "references", "citations", "cited", "cited_ids", "sources_cited", "quotes"]),
    ("relations", ["relations", "related", "links", "relationships"]),
    ("tags", ["tags", "keywords", "labels", "subjects", "themes", "topics"]),
    ("notes", ["notes", "note", "comment", "comments", "remarks", "description"]),
  ]

  /// `foldHeader(h)`: NFKD, combining marks U+0300–U+036F dropped, NFC, lower case, trimmed, runs of whitespace and
  /// `-./` → '_', leading and trailing '_' dropped.
  public static func foldHeader(_ h: String) -> String {
    let nfkd = (h as NSString).decomposedStringWithCompatibilityMapping
    let stripped = String(String.UnicodeScalarView(nfkd.unicodeScalars.filter { !(0x300...0x36F).contains($0.value) }))
    let lower = JSString.trim(JSString.toLowerCase((stripped as NSString).precomposedStringWithCanonicalMapping))
    var out: [UInt16] = []
    var inRun = false
    for u in lower.utf16 {
      if JSString.isWhitespace(u) || u == 0x2D || u == 0x2E || u == 0x2F {
        if !inRun { out.append(0x5F); inRun = true }
      } else {
        out.append(u)
        inRun = false
      }
    }
    while out.first == 0x5F { out.removeFirst() }
    while out.last == 0x5F { out.removeLast() }
    return String(decoding: out, as: UTF16.self)
  }

  /// Folded synonym → target (the first target that names it wins).
  static let synIndex: [UnitKey: String] = {
    var m: [UnitKey: String] = [:]
    for (target, names) in synonyms {
      for n in names {
        let k = UnitKey(foldHeader(n))
        if m[k] == nil { m[k] = target }
      }
    }
    return m
  }()

  static func synonymTarget(_ folded: String) -> String? { synIndex[UnitKey(folded)] }

  /// `nonEmpty(v)`.
  static func nonEmpty(_ v: JSValue?) -> Bool { !MappingRules.isBlank(v) }

  /// `asText(v)`: text, `String(n)`, a list joined with '; ', or JSON.
  static func asText(_ v: JSValue) -> String {
    switch v {
    case .string(let s): s
    case .number, .bool: JSText.string(v)
    case .array(let a): a.map { $0.isNull ? "" : JSText.string($0) }.joined(separator: "; ")
    default: JSText.stringify(v)
    }
  }

  static func isASCIIDigit(_ u: UInt16) -> Bool { u >= 0x30 && u <= 0x39 }

  /// `/^-?\d+$/`
  static func isInt(_ t: String) -> Bool {
    var u = Array(t.utf16)[...]
    if u.first == 0x2D { u = u.dropFirst() }
    return !u.isEmpty && u.allSatisfy(isASCIIDigit)
  }

  /// `/^[-+]?\d+([.,]\d+)?$/`
  static func isNumberLike(_ t: String) -> Bool {
    var u = Array(t.utf16)[...]
    if u.first == 0x2D || u.first == 0x2B { u = u.dropFirst() }
    let intPart = u.prefix(while: isASCIIDigit)
    guard !intPart.isEmpty else { return false }
    u = u.dropFirst(intPart.count)
    if u.isEmpty { return true }
    guard u.first == 0x2E || u.first == 0x2C else { return false }
    u = u.dropFirst()
    return !u.isEmpty && u.allSatisfy(isASCIIDigit)
  }

  /// `/^https?:\/\/\S+$/i`
  static func isURL(_ t: String) -> Bool {
    let u = Array(t.utf16)
    func at(_ s: String) -> Int? {
      let p = Array(s.utf16)
      guard u.count >= p.count else { return nil }
      for (k, c) in p.enumerated() where TextFiles.lower(u[k]) != c { return nil }
      return p.count
    }
    guard let n = at("https://") ?? at("http://"), u.count > n else { return false }
    return u[n...].allSatisfy { !JSString.isWhitespace($0) }
  }

  /// `/^[\p{L}-]+$/u`
  static func isLettersOrDash(_ t: String) -> Bool {
    !t.isEmpty && t.unicodeScalars.allSatisfy { $0.value == 0x2D || TokenClassTable.classes($0.value).contains(.letter) }
  }

  /// `/^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/i`
  static func isLangCode(_ t: String) -> Bool {
    let u = Array(t.utf16)
    func alpha(_ c: UInt16) -> Bool { (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) }
    func alnum(_ c: UInt16) -> Bool { alpha(c) || isASCIIDigit(c) }
    var i = 0
    while i < u.count && alpha(u[i]) { i += 1 }
    // the primary subtag is 2–3 letters (a longer run fails: the next code unit must be '-' or '_')
    for p in stride(from: min(i, 3), through: 2, by: -1) {
      var k = p
      var ok = true
      while k < u.count {
        guard u[k] == 0x2D || u[k] == 0x5F else { ok = false; break }
        var e = k + 1
        while e < u.count && alnum(u[e]) && e - k - 1 < 8 { e += 1 }
        if e - k - 1 < 2 { ok = false; break }
        k = e
      }
      if ok && k == u.count { return true }
    }
    return false
  }

  /// `inferColumn(name, values, {now})`.
  public static func inferColumn(_ name: String, _ values: [JSValue?], now: Date) -> ColumnInference {
    let vals = values.compactMap { $0 }.filter { nonEmpty($0) }
    let n = vals.count
    let texts = vals.map(asText)
    let avgLength = n > 0 ? Double(texts.reduce(0) { $0 + $1.utf16.count }) / Double(n) : 0
    let distinctN = Set(texts.map(UnitKey.init)).count
    let unique = n > 0 && distinctN == n
    let distinct = n > 0 ? Double(distinctN) / Double(n) : 0
    func out(_ inferred: String, dateShare: Double = 0, listSep: String? = nil) -> ColumnInference {
      ColumnInference(inferred: inferred, dateShare: dateShare, avgLength: avgLength, unique: unique, distinct: distinct, listSep: listSep, filled: n)
    }
    if n == 0 { return out("text") }
    let arrays = vals.filter { if case .array = $0 { true } else { false } }.count
    if arrays > 0 && Double(arrays) >= Double(n) / 2 { return out("list") }
    func share(_ pred: (String) -> Bool) -> Double { Double(texts.filter(pred).count) / Double(n) }
    if share({ isURL(JSString.trim($0)) }) > 0.8 { return out("url") }
    if share({ t in t.utf16.count <= 30 && MappingRules.normalizeLang(t) != nil && (t.utf16.count <= 3 || isLettersOrDash(t)) }) > 0.8
      && share({ t in t.utf16.count > 3 || isLangCode(JSString.trim(t)) }) > 0.8 {
      return out("lang")
    }
    let folded = foldHeader(name)
    let synonym = synonymTarget(folded)
    let idName = synonym == "ext_id"
    let allInt = share({ isInt(JSString.trim($0)) }) == 1
    let ctx = DateContext(now: DayMath.day(of: now))
    let dateShare = share { t in
      let p = DateGrammar.parse(t, context: ctx)
      return p.issue == nil && p.loDay != nil
    }
    let thisYear = DayMath.ymdFromDay(DayMath.day(of: now)).y
    let plausibleYears = allInt && share({ t in
      let y = Double(JSString.trim(t)) ?? .nan
      return y >= 1000 && y <= Double(thisYear + 10)
    }) == 1
    if dateShare > dateShareMin && !idName && (!allInt || plausibleYears) && !(allInt && unique && n >= 20 && synonym == nil) {
      return out("date", dateShare: dateShare)
    }
    if share({ isNumberLike(JSString.trim($0)) }) > 0.8 {
      return out(idName || (allInt && unique) ? "id" : "number", dateShare: dateShare)
    }
    for sep in [";", "|"] {
      let withSep = share { $0.contains(sep) }
      if withSep >= 0.3 && avgLength < 200 { return out("list", dateShare: dateShare, listSep: sep) }
    }
    if unique && avgLength <= 40 && share({ !JSString.trim($0).utf16.contains(where: JSString.isWhitespace) }) > 0.9 {
      return out("id", dateShare: dateShare)
    }
    return out("text", dateShare: dateShare)
  }

  /// `languageMap(values)`: an explicit map transform for the language names that are not codes.
  static func languageMap(_ values: [JSValue?]) -> JSObject? {
    var map = JSObject()
    var seen = Set<UnitKey>()
    for v in values.compactMap({ $0 }).filter({ nonEmpty($0) }).map({ JSString.trim(asText($0)) }) where seen.insert(UnitKey(v)).inserted {
      if let code = MappingRules.normalizeLang(v), !JSString.equal(code, v) { map[v] = .string(code) }
    }
    return map.isEmpty ? nil : map
  }

  /// The collection a file goes into (the upload step's `{slug, name, unit, license}`).
  public struct CollectionHint: Sendable, Equatable {
    public var slug: String?
    public var name: String?
    public var unit: String?
    public var license: String?
    public init(slug: String? = nil, name: String? = nil, unit: String? = nil, license: String? = nil) {
      self.slug = slug
      self.name = name
      self.unit = unit
      self.license = license
    }
  }

  /// `suggestMapping(columns, opts)`: each canonical target pre-filled from header synonyms and sampled values; every
  /// field carries its `reason`.
  public static func suggestMapping(_ columns: [SuggestColumn], format: String = "csv", delimiter: String? = nil, header: Bool? = nil,
                                    encoding: String = "utf-8", pointer: String? = nil, fileName: String = "import",
                                    collection: CollectionHint? = nil, now: Date) -> JSObject {
    struct Info {
      var name: String
      var samples: [JSValue?]
      var values: [JSValue?]?
      var inf: ColumnInference
      var folded: String
    }
    let info = columns.map { c in
      Info(name: c.name, samples: c.samples, values: c.values, inf: inferColumn(c.name, c.values ?? c.samples, now: now), folded: foldHeader(c.name))
    }
    var fields = JSObject()
    var used = Set<UnitKey>()
    func take(_ target: String, _ col: Info, _ reason: String) {
      fields[target] = .object(JSObject([("from", .string(col.name)), ("reason", .string(reason))]))
      used.insert(UnitKey(col.name))
    }
    func isUsed(_ c: Info) -> Bool { used.contains(UnitKey(c.name)) }

    // 1. header synonyms (first match per target wins; a column serves one target), checked against the values
    func datey(_ c: Info) -> Bool { c.inf.filled == 0 || c.inf.inferred == "date" || c.inf.dateShare >= 0.3 }
    func guardOK(_ target: String, _ c: Info) -> Bool {
      switch target {
      case "ext_id": c.inf.filled == 0 || c.inf.distinct >= 0.5
      case "source_url": c.inf.inferred == "url" || ["url", "link", "href", "uri", "source_url", "permalink"].contains(c.folded)
      case "date", "date_end", "referenced_date": datey(c)
      case "text": c.inf.inferred != "number" && c.inf.inferred != "date"
      case "language": c.inf.filled == 0 || c.inf.inferred == "lang" || c.inf.avgLength <= 24
      default: true
      }
    }
    for col in info {
      guard let target = synonymTarget(col.folded), !fields.has(target), !isUsed(col) else { continue }
      if !guardOK(target, col) { continue }
      take(target, col, "header '\(col.name)' is a common name for \(replaceFirst(target, "_", " "))")
    }
    // 2. value sniffing
    if !fields.has("date") {
      let cands = info.filter { !isUsed($0) && $0.inf.inferred == "date" }
      if let best = cands.enumerated().max(by: { a, b in a.element.inf.dateShare < b.element.inf.dateShare || (a.element.inf.dateShare == b.element.inf.dateShare && a.offset > b.offset) })?.element {
        take("date", best, "\(JSNumber.format(JSNumber.round(best.inf.dateShare * 100)))% of sampled values parse as dates")
      }
    }
    if !fields.has("text") {
      let cands = info.filter { !isUsed($0) && $0.inf.inferred == "text" && $0.inf.avgLength >= 20 }
      if let best = cands.enumerated().max(by: { a, b in a.element.inf.avgLength < b.element.inf.avgLength || (a.element.inf.avgLength == b.element.inf.avgLength && a.offset > b.offset) })?.element {
        take("text", best, "longest average value (\(JSNumber.format(JSNumber.round(best.inf.avgLength))) characters)")
      }
    }
    if !fields.has("title") {
      // sorted by ascending average length (stable), then the last one: the longest, the later of equals
      let cands = info.filter { !isUsed($0) && $0.inf.inferred == "text" && $0.inf.avgLength > 0 && $0.inf.avgLength < 160 }
      var best: Info?
      for c in cands where best == nil || c.inf.avgLength >= best!.inf.avgLength { best = c }
      if let best, fields.has("text") {
        take("title", best, "short text column (average \(JSNumber.format(JSNumber.round(best.inf.avgLength))) characters)")
      }
    }
    if !fields.has("ext_id"), let best = info.first(where: { !isUsed($0) && $0.inf.inferred == "id" && $0.inf.unique }) {
      take("ext_id", best, "every sampled value is distinct and id-like")
    }
    if !fields.has("language"), let best = info.first(where: { !isUsed($0) && $0.inf.inferred == "lang" }) {
      take("language", best, "values are language names or codes")
    }
    if !fields.has("source_url"), let best = info.first(where: { !isUsed($0) && $0.inf.inferred == "url" }) {
      take("source_url", best, "values are web addresses")
    }

    // 3. transforms
    func setTransform(_ target: String, _ t: JSValue) {
      guard case .object(var o)? = fields[target] else { return }
      o["transform"] = t
      fields[target] = .object(o)
    }
    func fromOf(_ target: String) -> String? { fields[target]?["from"]?.stringValue }
    if fields.has("title") { setTransform("title", .array([.string("trim")])) }
    for t in ["date", "date_end", "referenced_date"] where fields.has(t) {
      setTransform(t, .array([.object(JSObject([("date", .object(JSObject([("circa_radius", .number(5)), ("two_digit_century", .null)])))]))]))
    }
    if fields.has("language") {
      let col = info.first { JSString.equal($0.name, fromOf("language") ?? "") }
      if let map = languageMap(col?.values ?? col?.samples ?? []) {
        setTransform("language", .array([.object(JSObject([("map", .object(map))]))]))
      }
    }
    for t in ["cites", "tags"] where fields.has(t) {
      let col = info.first { JSString.equal($0.name, fromOf(t) ?? "") }
      if col?.inf.inferred == "list" && col?.inf.listSep == nil { continue }  // JSON arrays need no split
      let commaTags = t == "tags" && (col?.values ?? []).contains { if case .string(let s)? = $0 { s.contains(",") && !s.contains(";") } else { false } }
      let sep = col?.inf.listSep ?? (commaTags ? "," : ";")
      setTransform(t, .array([.object(JSObject([("split", .string(sep))]))]))
    }
    if format == "txt" || format == "md" {
      fields["text"] = .object(JSObject([("from", .string("text")), ("reason", .string("the body of the \(format.uppercased()) file"))]))
      if !fields.has("title") {
        fields["title"] = .object(JSObject([("from", .string("title")), ("transform", .array([.string("trim")])),
                                            ("reason", .string("the title line, front matter, first heading or file name"))]))
      }
    }

    let stem = TextFiles.fileStem(fileName)
    func nonEmptyText(_ s: String?) -> String? { (s?.isEmpty ?? true) ? nil : s }
    let unit = collection?.unit == "works" || collection?.unit == "tokens" ? collection!.unit! : fields.has("text") ? "tokens" : "works"
    let coll = JSObject([
      ("slug", .string(IDs.slug(nonEmptyText(collection?.slug) ?? nonEmptyText(collection?.name) ?? stem))),
      ("name", .string(nonEmptyText(collection?.name) ?? stem)),
      ("unit", .string(unit)),
      ("license", collection?.license.map(JSValue.string) ?? .null),
    ])
    var out = JSObject([
      ("format", .string(format)), ("encoding", .string(encoding)), ("collection", .object(coll)), ("fields", .object(fields)),
      ("options", .object(JSObject([("dedupe", .string("flag")), ("detect_language", .bool(true)), ("on_bad_row", .string("skip_and_report")),
                                    ("line_mode", .bool(false))]))),
    ])
    if format == "csv" || format == "tsv" {
      out["delimiter"] = .string(delimiter ?? (format == "tsv" ? "\t" : ","))
      out["header"] = .bool(header ?? true)
    }
    if format == "json" { out["pointer"] = .string(pointer ?? "") }
    return out
  }

  /// `s.replace('_', ' ')`: the first occurrence only.
  static func replaceFirst(_ s: String, _ a: String, _ b: String) -> String {
    let i = JSString.indexOf(s, a)
    guard i >= 0 else { return s }
    return JSString.slice(s, 0, i) + b + JSString.slice(s, i + a.utf16.count)
  }
}
