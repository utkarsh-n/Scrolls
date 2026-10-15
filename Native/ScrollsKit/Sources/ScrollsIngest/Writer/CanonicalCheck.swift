// OWNER: N1
// `check('CanonicalDocument' | 'CanonicalRelationship' | 'CanonicalAnnotation', x)` of src/shared/contracts.mjs, for
// the typed Swift records: the shape errors the types cannot rule out (enumerations, finite numbers, the DateParse
// rules), then the refine rules (only when the shape had no error), then "a gated object carries no numeral" over the
// verbatim metadata. Messages, paths and order are the reference's, because a rejection's message quotes the first
// three ("Record x does not match the document contract: …").

import Foundation
import ScrollsContracts
import ScrollsCore

/// The reference's contract checks of canonical records.
public enum CanonicalCheck {
  static let maxErrors = 50

  /// `JSON.stringify(v)` of a string (the "got …" of an enumeration error).
  static func got(_ s: String) -> String { CanonicalJSON.quote(s) }

  static func enumError(_ path: String, _ list: [String], _ v: String) -> String? {
    list.contains(where: { JSString.equal($0, v) }) ? nil : "\(path): expected one of \(list.joined(separator: "|")), got \(got(v))"
  }

  static func number(_ path: String, _ v: Double?) -> String? {
    guard let v, !v.isFinite else { return nil }
    return "\(path): expected number|null, got number"
  }

  static func dateParse(_ path: String, _ p: DateParse, _ errs: inout [String]) {
    let before = errs.count
    if let e = enumError("\(path).precision", Vocab.precisions, p.precision) { errs.append(e) }
    if let e = enumError("\(path).basis", Vocab.bases, p.basis) { errs.append(e) }
    guard errs.count == before else { return }
    if (p.precision == "unknown") != (p.loDay == nil) { errs.append("\(path): precision 'unknown' iff lo_day is null") }
    if let lo = p.loDay, p.hiDay == nil || lo > p.hiDay! { errs.append("\(path): lo_day must be ≤ hi_day") }
  }

  /// `check('CanonicalDocument', doc)`.
  public static func document(_ d: CanonicalDocument) -> [String] {
    var e: [String] = []
    if let x = number("$.prominence", d.prominence) { e.append(x) }
    if let t = d.text {
      if let x = enumError("$.text.decoder", Vocab.decoders, t.decoder) { e.append(x) }
      for (i, r) in (t.regions ?? []).enumerated() {
        if let q = r.quality, let x = enumError("$.text.regions[\(i)].quality", Vocab.qualities, q) { e.append(x) }
        if let q = r.timeRole, let x = enumError("$.text.regions[\(i)].time_role", Vocab.timeRoles, q) { e.append(x) }
        if let q = r.fieldClass, let x = enumError("$.text.regions[\(i)].field_class", Vocab.fieldClasses, q) { e.append(x) }
      }
      if let m = t.mode, let x = enumError("$.text.mode", ["auto", "prose", "verse"], m) { e.append(x) }
    }
    if let r = d.fieldRoles {
      if let s = r.summary, let x = enumError("$.field_roles.summary", ["describes", "document"], s) { e.append(x) }
      if let s = r.abstract, let x = enumError("$.field_roles.abstract", ["describes", "document"], s) { e.append(x) }
    }
    for (i, x) in d.dates.enumerated() {
      if let m = enumError("$.dates[\(i)].role", Vocab.dateRoles, x.role) { e.append(m) }
      if let p = x.parsed { dateParse("$.dates[\(i)].parsed", p, &e) }
    }
    for (i, t) in (d.tags ?? []).enumerated() {
      if let x = enumError("$.tags[\(i)].scheme", Vocab.tagSchemes, t.scheme) { e.append(x) }
      if let x = number("$.tags[\(i)].weight", t.weight) { e.append(x) }
      if let x = enumError("$.tags[\(i)].provenance", Vocab.tagProvenance, t.provenance) { e.append(x) }
    }
    if d.originalMeta.objectValue == nil {
      e.append("$.original_meta: expected object, got \(typeName(d.originalMeta))")
    }
    if e.isEmpty { e += d.violations().map { "$: \($0)" } }
    gateNumerals(d.originalMeta, "$.original_meta", &e)
    return Array(e.prefix(maxErrors))
  }

  /// `check('CanonicalRelationship', rel)`.
  public static func relationship(_ r: CanonicalRelationship) -> [String] {
    var e: [String] = []
    if let x = enumError("$.evidence_status", Vocab.evidenceStatus, r.evidenceStatus) { e.append(x) }
    if let x = enumError("$.origin", Vocab.origins, r.origin) { e.append(x) }
    if let q = r.provenanceQuality, let x = enumError("$.provenance_quality", Vocab.provenanceQuality, q) { e.append(x) }
    if let s = r.score {
      if !s.value.isFinite { e.append("$.score.value: expected number, got number") }
      if let x = enumError("$.score.kind", Vocab.scoreKinds, s.kind) { e.append(x) }
    }
    for (i, ev) in (r.evidence ?? []).enumerated() {
      if let x = enumError("$.evidence[\(i)].role", Vocab.evidenceRoles, ev.role) { e.append(x) }
    }
    if e.isEmpty { e += r.violations().map { "$: \($0)" } }
    return Array(e.prefix(maxErrors))
  }

  /// `check('CanonicalAnnotation', ann)`.
  public static func annotation(_ a: CanonicalAnnotation) -> [String] {
    var e: [String] = []
    if let x = enumError("$.target.type", Vocab.annotationTargets, a.target.type) { e.append(x) }
    if let x = enumError("$.kind", Vocab.annotationKinds, a.kind) { e.append(x) }
    if let s = a.stance, let x = enumError("$.stance", Vocab.stances, s) { e.append(x) }
    if let d = a.dimensions, !d.isNull, d.objectValue == nil { e.append("$.dimensions: expected object, got \(typeName(d))") }
    if let r = a.evidenceRefs, !r.isNull, r.arrayValue == nil { e.append("$.evidence_refs: expected array, got \(typeName(r))") }
    if e.isEmpty { e += a.violations().map { "$: \($0)" } }
    if let d = a.dimensions { gateNumerals(d, "$.dimensions", &e) }
    if let r = a.evidenceRefs { gateNumerals(r, "$.evidence_refs", &e) }
    return Array(e.prefix(maxErrors))
  }

  static func typeName(_ v: JSONValue) -> String {
    switch v {
    case .null: "null"
    case .array: "array"
    case .number(let n): n.isFinite && n == n.rounded(.towardZero) ? "integer" : "number"
    case .bool: "boolean"
    case .string: "string"
    case .object: "object"
    }
  }

  /// Gated objects anywhere in a payload carry no numeral (honesty rule 7).
  static func gateNumerals(_ v: JSONValue, _ path: String, _ errs: inout [String]) {
    if errs.count >= maxErrors { return }
    switch v {
    case .array(let a):
      for (i, x) in a.enumerated() { gateNumerals(x, "\(path)[\(i)]", &errs) }
    case .object(let o):
      if let g = o["gate"]?.stringValue, g != "ok", Vocab.gateCodes.contains(g) {
        for k in ["value", "ci", "ci_lo", "ci_hi", "null_percentile"] {
          if let x = o[k], !x.isNull { errs.append("\(path).\(k): gated (\(g)) but carries a value") }
        }
      }
      for k in o.keys.sorted(by: CanonicalJSON.codeUnitLess) { gateNumerals(o[k]!, "\(path).\(k)", &errs) }
    default: return
    }
  }
}
