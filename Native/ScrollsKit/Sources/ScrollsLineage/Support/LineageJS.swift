// OWNER: N5
// The JavaScript and SQLite semantics the lineage read paths depend on (graph.mjs, path.mjs, genealogy.mjs, trace.mjs):
// query strings are strings, `Number.parseInt(x, 10) || d`, comma lists, `/\s+/g → ' '` with trim, and SQLite's
// `substr(text, start + 1, n)`, which counts Unicode code points (not the UTF-16 units of D4). Each helper names the
// expression it reproduces.

import Foundation
import ScrollsContracts
import ScrollsCore

/// Query arguments as the reference's routes receive them: every value a string (absent = nil).
public typealias QueryArgs = [String: String]

enum LineageJS {
  /// `Number.parseInt(s, 10)`: optional leading whitespace and sign, then the longest run of decimal digits; NaN (nil)
  /// when there is none. Values beyond Int's range saturate (the callers clamp them anyway).
  static func parseInt(_ s: String?) -> Int? {
    guard let s else { return nil }
    let u = Array(s.utf16)
    var i = 0
    while i < u.count, JSString.isWhitespace(u[i]) { i += 1 }
    var negative = false
    if i < u.count, u[i] == 0x2B || u[i] == 0x2D {
      negative = u[i] == 0x2D
      i += 1
    }
    var v = 0
    var digits = 0
    while i < u.count, u[i] >= 0x30 && u[i] <= 0x39 {
      let (m, o1) = v.multipliedReportingOverflow(by: 10)
      let (a, o2) = m.addingReportingOverflow(Int(u[i] - 0x30))
      v = o1 || o2 ? Int.max : a
      digits += 1
      i += 1
    }
    guard digits > 0 else { return nil }
    return negative ? -v : v
  }

  /// `Number.parseInt(s ?? fallback, 10) || fallback` (NaN and 0 both give the fallback).
  static func parseIntOr(_ s: String?, _ fallback: Int) -> Int {
    let v = parseInt(s ?? String(fallback))
    return v == nil || v == 0 ? fallback : v!
  }

  /// `Math.min(hi, Math.max(lo, v))`.
  static func clamp(_ v: Int, _ lo: Int, _ hi: Int) -> Int { Swift.min(hi, Swift.max(lo, v)) }

  /// graph.mjs `list(v)`: '' or nil → []; else split on ',', trim each, drop empties.
  static func list(_ v: String?) -> [String] {
    guard let v, !v.isEmpty else { return [] }
    return JSString.split(v, ",").map(JSString.trim).filter { !$0.isEmpty }
  }

  /// `s.replace(/\s+/g, ' ').trim()`.
  static func collapseWhitespace(_ s: String) -> String {
    var out: [UInt16] = []
    var inSpace = false
    for c in s.utf16 {
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

  /// SQLite `substr(X, start + 1, n)` on TEXT: `n` code points from code point `start` (0-based). Lone surrogates count
  /// as one character each (SQLite sees them as U+FFFD after node's UTF-8 conversion).
  static func substrCodePoints(_ u: [UInt16], start: Int, count n: Int) -> String {
    guard start >= 0, n > 0 else { return "" }
    var i = 0, cp = 0
    while i < u.count, cp < start {
      i += isPairStart(u, i) ? 2 : 1
      cp += 1
    }
    guard cp == start else { return "" }
    let from = i
    var taken = 0
    while i < u.count, taken < n {
      i += isPairStart(u, i) ? 2 : 1
      taken += 1
    }
    return String(decoding: u[from..<i], as: UTF16.self)
  }

  @inline(__always)
  static func isPairStart(_ u: [UInt16], _ i: Int) -> Bool {
    u[i] >= 0xD800 && u[i] <= 0xDBFF && i + 1 < u.count && u[i + 1] >= 0xDC00 && u[i + 1] <= 0xDFFF
  }

  /// `JSON.stringify(list)` of strings or numbers, the argument of `json_each(?)`.
  static func jsonList(_ items: [String]) -> String { CanonicalJSON.string(.array(items.map(JSONValue.string))) }
  static func jsonList(_ items: [Int64]) -> String { CanonicalJSON.string(.array(items.map { .number(Double($0)) })) }

  /// `/^[a-z_]+:.+/` — a reference such as 'passage:77'.
  static func isRef(_ s: String) -> Bool {
    let u = Array(s.utf16)
    var i = 0
    while i < u.count, (u[i] >= 0x61 && u[i] <= 0x7A) || u[i] == 0x5F { i += 1 }
    guard i > 0, i < u.count, u[i] == 0x3A else { return false }
    // `.+`: at least one character that is not a line terminator
    let rest = u[(i + 1)...]
    guard let first = rest.first else { return false }
    return !(first == 0x0A || first == 0x0D || first == 0x2028 || first == 0x2029)
  }

  /// `ref.slice(0, i)`, `ref.slice(i + 1)` around the first ':'.
  static func splitRef(_ ref: String) -> (type: String, id: String) {
    let u = Array(ref.utf16)
    guard let i = u.firstIndex(of: 0x3A) else { return (ref, "") }
    return (String(decoding: u[..<i], as: UTF16.self), String(decoding: u[(i + 1)...], as: UTF16.self))
  }

  /// `(n).toLocaleString('en-US')` of an integer.
  static func grouped(_ n: Int) -> String { Format.int(n) }
}

extension ScrollsError {
  /// `invalid(message, field)` of graph.mjs / path.mjs / genealogy.mjs: 400 E_VALIDATION with `{field}`.
  static func lineageInvalid(_ message: String, field: String?, hint: String? = nil) -> ScrollsError {
    ScrollsError(code: .validation, message: message, hint: hint, detail: ["field": field.map(JSONValue.string) ?? .null],
                 status: 400)
  }

  /// `new HttpError(404, 'E_NOT_FOUND', message, hint)`.
  static func lineageNotFound(_ message: String, hint: String? = nil, detail: JSONValue = .null) -> ScrollsError {
    ScrollsError(code: .notFound, message: message, hint: hint, detail: detail, status: 404)
  }
}
