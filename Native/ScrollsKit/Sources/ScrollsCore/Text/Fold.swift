// OWNER: N0
// Port of foldToken (src/shared/tokenize.mjs): NFC → toLowerCase() → Devanagari/Gujarati digits to ASCII → remove
// U+200C, U+200D, U+00AD. Accents are kept (analysis is accent-sensitive; FTS is not).
//
// Lowercasing is JSString.toLowerCase (V8's ICU mapping): never Swift's own String lowercasing, which breaks Final_Sigma
// ("ΟΔΟΣ" → "οδοσ" where JavaScript gives "οδος"; IOS-SPEC §0.2, DV-1). LintTests ban the Swift call.

import Foundation

/// The token fold of tokenizer u61m-1.
public enum Fold {
  /// Folds one token (or any string) exactly as the reference's `foldToken`.
  public static func fold(_ raw: String) -> String {
    if raw.utf8.allSatisfy({ $0 < 0x80 }) { return asciiLowercased(raw) }
    let lower = JSString.toLowerCase((raw as NSString).precomposedStringWithCanonicalMapping)
    var out: [UInt16] = []
    out.reserveCapacity(lower.utf16.count)
    for u in lower.utf16 {
      switch u {
      case 0x0966...0x096F: out.append(0x30 + (u - 0x0966))  // Devanagari digits
      case 0x0AE6...0x0AEF: out.append(0x30 + (u - 0x0AE6))  // Gujarati digits
      case 0x200C, 0x200D, 0x00AD: continue  // ZWNJ, ZWJ, soft hyphen
      default: out.append(u)
      }
    }
    return String(decoding: out, as: UTF16.self)
  }

  /// JavaScript `toLowerCase()` of an ASCII-only string (A–Z → a–z).
  public static func asciiLowercased(_ s: String) -> String {
    var bytes = Array(s.utf8)
    for i in bytes.indices where bytes[i] >= 0x41 && bytes[i] <= 0x5A { bytes[i] += 0x20 }
    return String(decoding: bytes, as: UTF8.self)
  }

  /// Folds the UTF-16 code units of one token. ASCII spans skip Foundation entirely.
  static func fold(units: UnsafeBufferPointer<UInt16>) -> String {
    var ascii = true
    for u in units where u >= 0x80 { ascii = false; break }
    if ascii {
      return String(unsafeUninitializedCapacity: units.count) { buf in
        for (i, u) in units.enumerated() {
          let b = UInt8(truncatingIfNeeded: u)
          buf[i] = (b >= 0x41 && b <= 0x5A) ? b + 0x20 : b
        }
        return units.count
      }
    }
    return fold(String(decoding: units, as: UTF16.self))
  }
}
