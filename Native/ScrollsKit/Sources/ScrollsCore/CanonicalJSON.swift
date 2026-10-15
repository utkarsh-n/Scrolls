// OWNER: N0
// Port of canonicalJson (src/shared/ids.mjs): recursively sorted keys, no whitespace, numbers as JSON.stringify
// writes them. It feeds params_hash, state_hash and input_fingerprint, so it must be byte-equal with Node.

/// The canonical JSON text of a value, byte-equal with the reference's `canonicalJson`.
public enum CanonicalJSON {
  /// Sorted keys (UTF-16 code-unit order, as `Array.prototype.sort`), no whitespace, numbers via `JSNumber.format`,
  /// non-finite numbers as `null` (as `JSON.stringify`).
  public static func string(_ v: JSONValue) -> String {
    var out: [UInt16] = []
    out.reserveCapacity(256)
    write(v, into: &out)
    return String(decoding: out, as: UTF16.self)
  }

  /// `JSON.stringify` of a string: the quoted, escaped form (QuoteJSONString).
  public static func quote(_ s: String) -> String {
    var out: [UInt16] = []
    out.reserveCapacity(s.utf16.count + 2)
    appendQuoted(s, into: &out)
    return String(decoding: out, as: UTF16.self)
  }

  /// Sorts strings as `Array.prototype.sort()` does by default: by UTF-16 code units.
  public static func codeUnitLess(_ a: String, _ b: String) -> Bool {
    a.utf16.lexicographicallyPrecedes(b.utf16)
  }

  static func write(_ v: JSONValue, into out: inout [UInt16]) {
    switch v {
    case .null: out.append(contentsOf: "null".utf16)
    case .bool(let b): out.append(contentsOf: (b ? "true" : "false").utf16)
    case .number(let n): out.append(contentsOf: (n.isFinite ? JSNumber.format(n) : "null").utf16)
    case .string(let s): appendQuoted(s, into: &out)
    case .array(let a):
      out.append(0x5B)
      for (k, x) in a.enumerated() {
        if k > 0 { out.append(0x2C) }
        write(x, into: &out)
      }
      out.append(0x5D)
    case .object(let o):
      out.append(0x7B)
      var first = true
      for key in o.keys.sorted(by: codeUnitLess) {
        if !first { out.append(0x2C) }
        first = false
        appendQuoted(key, into: &out)
        out.append(0x3A)
        write(o[key]!, into: &out)
      }
      out.append(0x7D)
    }
  }

  static func appendQuoted(_ s: String, into out: inout [UInt16]) {
    let hex: [UInt16] = Array("0123456789abcdef".utf16)
    out.append(0x22)
    for u in s.utf16 {
      switch u {
      case 0x22: out.append(contentsOf: [0x5C, 0x22])
      case 0x5C: out.append(contentsOf: [0x5C, 0x5C])
      case 0x08: out.append(contentsOf: [0x5C, 0x62])
      case 0x0C: out.append(contentsOf: [0x5C, 0x66])
      case 0x0A: out.append(contentsOf: [0x5C, 0x6E])
      case 0x0D: out.append(contentsOf: [0x5C, 0x72])
      case 0x09: out.append(contentsOf: [0x5C, 0x74])
      case 0..<0x20:
        out.append(contentsOf: [0x5C, 0x75, 0x30, 0x30, hex[Int(u >> 4)], hex[Int(u & 15)]])
      default: out.append(u)
      }
    }
    out.append(0x22)
  }
}
