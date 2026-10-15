// OWNER: N3
// The Exports menu's own words (IOS-SPEC §3.10, SPEC §7.3). British English; no mental-state verbs; what travels with
// every file is said plainly: the manifest first, licences and attributions, synthetic rows labelled, and no text from a
// collection whose licence does not allow it.

nonisolated enum ExportsCopy {
  static let title = "Export"
  static let occurrences = "Occurrences"
  static let aggregates = "Counts per bin"
  static let passages = "Passages"
  static let relationships = "Relationships"
  static let annotations = "Annotations"
  static let json = "JSON"
  static let jsonl = "JSONL"
  static let csv = "CSV"
  static let manifestNote = "Every file starts with its manifest: data version, runs, filters, licences and attributions."
  static let withheldNote = "Collections whose licence does not allow it export ids, offsets and source links only — never their text."
  static let syntheticNote = "Synthetic demonstration rows are marked SYNTHETIC in every format."
  static let noStrand = "Pin an expression first: there is nothing to export yet."
  static let preparing = "Preparing the export…"
  static func fileName(_ what: String, _ format: String) -> String { "\(what).\(format)" }
}
