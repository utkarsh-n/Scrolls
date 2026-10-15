// OWNER: N3
// The SQL slice of a def (query.mjs docWhere / rowWhere / sliceWhere / strandSource / strandDocRows, marks.mjs
// occurrenceSql, lanes.mjs facetSql / unitClassSql / trailValueSql, langgate.mjs langAdmitsSql): the one definition every
// numerator and denominator reads, verbatim from the reference so the phone counts exactly what the web counts. The
// statements are composed at run time (filters, lanes, strand members) and prepared through the connection's dynamic
// statement LRU; the slice cube (Slice/Cube.swift) is the same predicate over its columns.

import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A fragment of SQL with its positional parameters.
public struct SQLPart: Sendable {
  public var sql: String
  public var params: [SQLValue]
  public init(_ sql: String, _ params: [SQLValue] = []) {
    self.sql = sql
    self.params = params
  }
}

/// Column names of a passage-level row.
public struct RowCols: Sendable {
  public var plang: String
  public var fc: String
  public var grp: String?
  public var dlang: String?

  /// `rowCols(alias, passage, grp)`: expr_doc / doc_tokens have `plang`, passage has `lang`.
  public init(_ alias: String, passage: Bool = false, grp: String? = nil) {
    plang = "\(alias).\(passage ? "lang" : "plang")"
    fc = "\(alias).field_class"
    self.grp = grp
  }
}

/// The SQL slice.
public enum SliceSQL {
  static let filterColumns: [(key: String, col: String)] = [("kind", "d.kind"), ("coll", "c.slug"), ("culture", "d.culture"),
                                                            ("field", "d.field"), ("community", "d.community"), ("basis", "d.basis")]

  static func includeExclude(_ vals: [String]) -> (inc: [String], exc: [String]) {
    (vals.filter { !JSString.hasPrefix($0, "-") }, vals.filter { JSString.hasPrefix($0, "-") }.map { JSText.slice($0, 1) })
  }

  /// `docWhere(def)`: document- and collection-level conditions (aliases d, c).
  public static func docWhere(_ def: QueryDef) -> SQLPart {
    let ids = def.corpusIds
    let savedAt = def.cutoffs?.at
    var w = [savedAt != nil ? "(d.deleted_at IS NULL OR d.deleted_at > ?)" : "d.deleted_at IS NULL",
             ids.count == 1 ? "c.corpus_id = ?" : "c.corpus_id IN (SELECT value FROM json_each(?))",
             def.readsEndpoints ? "(c.rate_eligible = 1 OR c.sampling = 'relation_endpoints')" : "c.rate_eligible = 1"]
    var p: [SQLValue] = []
    if let savedAt { p.append(.text(savedAt)) }
    p.append(ids.count == 1 ? .int(ids[0]) : .text(SQLJSON.ints(ids)))
    if def.toggle("tr") == 0 { w.append("d.is_translation = 0") }
    if def.toggle("dup") == 0 { w.append("d.dup_of IS NULL") }
    if def.toggle("est") == 0 { w.append("d.basis <> 'estimated'") }
    if def.f.syn == 0 { w.append("d.is_synthetic = 0") }
    if let cut = def.cutoffs?.importBatch {
      w.append("(d.import_batch_id IS NULL OR d.import_batch_id <= ?)")
      p.append(.int(cut))
    }
    for (key, col) in filterColumns {
      let (inc, exc) = includeExclude(def.f[listKey: key])
      if !inc.isEmpty {
        w.append("\(col) IN (SELECT value FROM json_each(?))")
        p.append(.text(SQLJSON.strings(inc)))
      }
      if !exc.isEmpty {
        w.append("(\(col) IS NULL OR \(col) NOT IN (SELECT value FROM json_each(?)))")
        p.append(.text(SQLJSON.strings(exc)))
      }
    }
    return SQLPart(w.joined(separator: " AND "), p)
  }

  static func und(_ col: String) -> String { "(\(col) = 'und' OR \(col) LIKE 'und-%')" }

  /// `langAdmitsSql(cols, langs)` (RF-1).
  public static func langAdmits(_ cols: RowCols, _ langs: [String]) -> SQLPart {
    let dlang = cols.dlang ?? "d.lang_text"
    let json = SQLJSON.strings(langs)
    return SQLPart("""
      (\(cols.plang) IN (SELECT value FROM json_each(?)) AND (NOT \(und(cols.plang))
            OR \(cols.fc) NOT IN ('text', 'abstract', 'apparatus') OR \(dlang) IS NULL OR \(dlang) = '' OR \(und(dlang))
            OR \(dlang) IN (SELECT value FROM json_each(?))))
      """, [.text(json), .text(json)])
  }

  /// `rowWhere(def, cols, langs)`: passage-level conditions — counted field classes, the strand's languages, the `lang`
  /// filter and, on the Term trail, rows that belong to a trail lane.
  public static func rowWhere(_ def: QueryDef, _ cols: RowCols, _ langs: LangSpec) -> SQLPart {
    var w = ["\(cols.fc) IN (SELECT value FROM json_each(?))"]
    var p: [SQLValue] = [.text(SQLJSON.strings(def.fieldClasses))]
    switch langs {
    case .any: break
    case .list(let l):
      let g = langAdmits(cols, l)
      w.append(g.sql)
      p += g.params
    case .byCorpus(let by):
      var parts: [String] = []
      for (id, l) in by {
        if let l {
          let g = langAdmits(cols, l)
          parts.append("(c.corpus_id = ? AND \(g.sql))")
          p.append(.int(id))
          p += g.params
        } else {
          parts.append("c.corpus_id = ?")
          p.append(.int(id))
        }
      }
      w.append("(\(parts.isEmpty ? "0" : parts.joined(separator: " OR ")))")
    }
    let (inc, exc) = includeExclude(def.f.lang)
    if !inc.isEmpty {
      w.append("\(cols.plang) IN (SELECT value FROM json_each(?))")
      p.append(.text(SQLJSON.strings(inc)))
    }
    if !exc.isEmpty {
      w.append("\(cols.plang) NOT IN (SELECT value FROM json_each(?))")
      p.append(.text(SQLJSON.strings(exc)))
    }
    if def.lanes.facet == "trail" { w.append("\(trailValue(cols)) IS NOT NULL") }
    return SQLPart(w.joined(separator: " AND "), p)
  }

  /// `sliceWhere(def, cols, langs)`.
  public static func sliceWhere(_ def: QueryDef, _ cols: RowCols, _ langs: LangSpec) -> SQLPart {
    let a = docWhere(def), b = rowWhere(def, cols, langs)
    return SQLPart("\(a.sql) AND \(b.sql)", a.params + b.params)
  }

  static func sqlList(_ xs: [String]) -> String { xs.map { "'\($0)'" }.joined(separator: ", ") }

  /// `trailValueSql(cols)`: the trail lane value of a row, NULL outside every trail lane.
  public static func trailValue(_ cols: RowCols) -> String {
    let fc = cols.fc
    let textish = "\(fc) NOT IN ('title', 'abstract')"
    return """
      (CASE WHEN c.sampling = 'relation_endpoints' THEN (CASE WHEN \(fc) = 'title' THEN 'music-relations' END)
          WHEN c.sampling = 'top_cited_per_cell' THEN (CASE WHEN \(fc) IN ('title', 'abstract') AND d.field IN (\(sqlList(TrailLanes.cellFields)))
            THEN 'stemm-abstracts:' || d.field END)
          WHEN c.domain = 'literature' THEN (CASE WHEN \(textish) THEN 'literature-text' END)
          WHEN c.domain = 'stemm' THEN (CASE WHEN \(textish) AND d.field IN (\(sqlList(TrailLanes.textFields))) THEN 'stemm-text:' || d.field END)
          WHEN c.domain = 'culture' THEN (CASE WHEN \(fc) = 'title' THEN 'culture-titles' END) END)
      """
  }

  static let trailUnit = """
    (CASE WHEN c.sampling = 'top_cited_per_cell' THEN 'cells'
      WHEN c.sampling = 'relation_endpoints' OR c.domain = 'culture' THEN 'titles' ELSE 'text' END)
    """

  /// `unitSql(cols)`: the unit class of a passage-level row.
  public static func unit(_ cols: RowCols) -> String {
    "CASE \(cols.fc) WHEN 'title' THEN 'titles' WHEN 'abstract' THEN 'abstracts' ELSE 'text' END"
  }

  /// `unitClassSql(facet, cols)`.
  public static func unitClass(_ facet: String, _ cols: RowCols) -> String { facet == "trail" ? trailUnit : unit(cols) }

  /// `facetSql(facet, cols)`: a facet's lane value.
  public static func facet(_ facet: String, _ cols: RowCols) -> String {
    switch facet {
    case "trail": trailValue(cols)
    case "cluster": cols.grp ?? "NULL"
    case "domain": "c.domain"
    case "community": "d.community"
    case "kind": "d.kind"
    case "culture": "d.culture"
    case "collection": "c.slug"
    case "field": "d.field"
    case "date_basis": "d.basis"
    case "modality": unit(cols)
    case "language": cols.plang
    default: "NULL"
    }
  }

  /// `srcCols(def)`: numerator rows read through a strand source (alias e); cluster lanes carry the group.
  public static func srcCols(_ def: QueryDef) -> RowCols { RowCols("e", grp: def.lanes.facet == "cluster" ? "e.grp" : nil) }

  /// `occurrenceRunSql(strand, alias)`.
  public static func occurrenceRuns(_ strand: DefStrand, alias: String = "o") -> SQLPart {
    let pairs = strand.memberRuns
    if pairs.isEmpty { return SQLPart("0") }
    return SQLPart("(" + pairs.map { _ in "(\(alias).expression_id = ? AND \(alias).run_id = ?)" }.joined(separator: " OR ") + ")",
                   pairs.flatMap { [SQLValue.int($0.expr), .int($0.run)] })
  }

  /// `strandSource(strand, def)`: numerator rows (document_id, plang, field_class, n, n_names, n_passages[, grp]).
  public static func strandSource(_ strand: DefStrand, _ def: QueryDef?) -> SQLPart? {
    if strand.type == "expression" {
      if strand.run == nil { return nil }
      if def?.lanes.facet == "cluster" {
        guard let def, def.clusterLanesOK, let cl = def.cluster else { return nil }
        let occ = occurrenceRuns(strand)
        return SQLPart("""
          SELECT o.document_id, p.lang AS plang, p.field_class, SUM(o.name_flag = 0) AS n, SUM(o.name_flag = 1) AS n_names,
                count(DISTINCT o.passage_id) AS n_passages, \(ClusterLanes.groupCaseSQL(cl, "m.cluster_id")) AS grp
              FROM occurrence o JOIN passage p ON p.id = o.passage_id \(ClusterLanes.memberJoinSQL(cl))
              WHERE \(occ.sql) AND p.quality = 'ok' GROUP BY o.document_id, p.lang, p.field_class, grp
          """, occ.params)
      }
      var branches: [String] = []
      var params: [SQLValue] = []
      let members = strand.members ?? [StrandMember(corpusId: 0, corpus: "", ref: strand.exprId, run: strand.run, langs: nil,
                                                    sampled: false, accentInsensitive: false)]
      for m in members {
        guard let ref = m.ref, let run = m.run else { continue }
        let own = strand.langsByCorpus != nil && m.langs != nil
        branches.append("""
          SELECT x.document_id, x.plang, x.field_class, x.n, x.n_names, x.n_passages FROM expr_doc x
                JOIN analysis_run r ON r.id = x.run_id AND r.status = 'succeeded' WHERE x.expression_id = ? AND x.run_id = ?\(own ? " AND x.plang IN (SELECT value FROM json_each(?))" : "")
          """)
        params += [.int(ref), .int(run)]
        if own { params.append(.text(SQLJSON.strings(m.langs!))) }
      }
      return branches.isEmpty ? nil : SQLPart(branches.joined(separator: " UNION ALL "), params)
    }
    if strand.type == "theme" {
      if def?.lanes.facet == "cluster" { return nil }
      return SQLPart("""
        SELECT t.document_id, dt.plang, dt.field_class, 1 AS n, 0 AS n_names, dt.passages AS n_passages FROM doc_tag t
              JOIN doc_tokens dt ON dt.document_id = t.document_id AND dt.field_class = 'title'
              WHERE t.scheme = 'theme' AND t.value = ? AND t.provenance = ?
        """, [.text(strand.ref.description), .string(strand.provenance)])
    }
    return nil
  }

  /// `laneWhere(def, key, cols)`: the lane condition of a lane key.
  public static func laneWhere(_ def: QueryDef, _ key: String, _ cols: RowCols) throws -> SQLPart {
    let p: LaneKeyParts
    do { p = try Lanes.parse(key) } catch {
      throw ScrollsErrorFactory.validation(error.message, field: "lane")
    }
    if p.facet != def.lanes.facet {
      throw ScrollsErrorFactory.validation("Lane '\(key)' is not a \(def.lanes.facet) lane of this query.", field: "lane")
    }
    let lv = facet(def.lanes.facet, cols)
    let parts = [p.value == nil ? "\(lv) IS NULL" : "\(lv) = ?", "\(unitClass(def.lanes.facet, cols)) = ?"]
    let params: [SQLValue] = p.value == nil ? [.text(p.unitClass)] : [.text(p.value!), .text(p.unitClass)]
    return SQLPart("(\(parts.joined(separator: " AND ")))", params)
  }

  /// `COUNTED`: every match in text lanes, the first match of each work in title and OpenAlex lanes.
  public static let counted = "(uc NOT IN ('titles', 'cells') OR rn = 1)"

  /// `occurrenceSql(def, strand, {where, params, lane})`: a strand's counted occurrences under the def.
  public static func occurrences(_ def: QueryDef, _ strand: DefStrand, where extra: String = "1", params: [SQLValue] = [],
                                 lane: String? = nil) throws -> SQLPart {
    let cluster = def.lanes.facet == "cluster" && def.cluster?.state == "ok"
    let grp: String? = cluster ? ClusterLanes.groupCaseSQL(def.cluster!, "m.cluster_id") : def.lanes.facet == "cluster" ? "NULL" : nil
    let cols = RowCols("p", passage: true, grp: grp)
    let slice = sliceWhere(def, cols, strand.langSpec)
    let lw = try lane.map { try laneWhere(def, $0, cols) } ?? SQLPart("1")
    let lv = facet(def.lanes.facet, cols), uc = unitClass(def.lanes.facet, cols)
    let runs = occurrenceRuns(strand)
    let sql = """
      SELECT o.id AS occ, o.passage_id AS passage, o.document_id AS doc, o.start_off, o.end_off, o.name_flag, o.variant_id,
              p.field, p.start_off AS p_start, p.end_off AS p_end, p.lang AS plang, p.field_class, \(lv) AS lv, \(uc) AS uc,
              d.chrono_status, d.lo_day, d.hi_day, d.y_lo, d.y_hi, d.precision, d.basis, d.date_label, d.date_role, d.title,
              d.author, d.kind, d.is_synthetic AS syn, c.slug AS collection, c.license, c.export_text_allowed,
              ROW_NUMBER() OVER (PARTITION BY \(lv), \(uc), o.document_id ORDER BY o.id) AS rn
            FROM occurrence o JOIN analysis_run r ON r.id = o.run_id AND r.status = 'succeeded'
            JOIN passage p ON p.id = o.passage_id JOIN document d ON d.id = o.document_id JOIN collection c ON c.id = d.collection_id
            \(cluster ? ClusterLanes.memberJoinSQL(def.cluster!) : "")
            WHERE \(runs.sql) AND p.quality = 'ok' AND (o.name_flag = 0 OR ? = 1)
              AND \(slice.sql) AND \(lw.sql) AND \(extra)
      """
    return SQLPart(sql, runs.params + [.int(Int64(def.toggle("nm")))] + slice.params + lw.params + params)
  }

  /// `strandDocRows` SQL: per lane × document rows of a strand under the def's slice, with the document's chronology.
  public static func strandDocRows(_ def: QueryDef, _ strand: DefStrand, where extra: String = "1", params: [SQLValue] = []) -> SQLPart? {
    guard let src = strandSource(strand, def) else { return nil }
    let cols = srcCols(def)
    let slice = sliceWhere(def, cols, strand.langSpec)
    let nm = def.toggle("nm") == 1 ? 1 : 0
    return SQLPart("""
      WITH src AS (\(src.sql))
          SELECT \(facet(def.lanes.facet, cols)) AS lv, \(unitClass(def.lanes.facet, cols)) AS uc, e.document_id AS doc,
            SUM(e.n + \(nm) * e.n_names) AS v, SUM(e.n_names) AS names, SUM(e.n_passages) AS passages, d.chrono_status, d.lo_day,
            d.hi_day, d.y_lo, d.y_hi, d.precision, d.basis, d.date_label, d.author, d.title, d.kind, d.is_synthetic AS syn,
            d.is_translation AS tr
          FROM src e CROSS JOIN document d ON d.id = e.document_id JOIN collection c ON c.id = d.collection_id
          WHERE \(slice.sql) AND \(extra)
          GROUP BY lv, uc, e.document_id
      """, src.params + slice.params + params)
  }

  /// Runs a composed statement and maps its rows.
  public static func all<T>(_ c: Connection, _ part: SQLPart, _ map: (Row) throws -> T) throws -> [T] {
    let s = try c.prepared(dynamic: part.sql)
    try s.bind(part.params)
    return try s.all(map)
  }

  /// Runs a composed statement and maps its first row.
  public static func first<T>(_ c: Connection, _ part: SQLPart, _ map: (Row) throws -> T) throws -> T? {
    let s = try c.prepared(dynamic: part.sql)
    try s.bind(part.params)
    return try s.first(map)
  }
}

extension ViewState.Filters {
  /// The list of a filter key (lang, kind, coll, culture, field, community, basis).
  public subscript(listKey key: String) -> [String] {
    switch key {
    case "lang": lang
    case "kind": kind
    case "coll": coll
    case "culture": culture
    case "field": field
    case "community": community
    case "basis": basis
    default: []
    }
  }
}

/// Errors with the reference's codes.
public enum ScrollsErrorFactory {
  /// 400 E_VALIDATION with `{field}` detail, as the reference's `bad(message, {field}, hint)`.
  public static func validation(_ message: String, field: String? = nil, hint: String? = nil) -> ScrollsError {
    ScrollsError.badRequest(.validation, message, hint: hint, detail: field.map { .object(["field": .string($0)]) } ?? .null)
  }
}
