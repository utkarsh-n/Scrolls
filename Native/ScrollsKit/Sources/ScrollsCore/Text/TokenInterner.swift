// OWNER: N0
// Interns token norms so each distinct raw form is folded once (IOS-SPEC §0.2: the naive Foundation fold runs at
// 2.4–3.3 M tokens/s; the tokenizer at 40 M). Keys compare by code units, not by Swift's canonical equivalence: two
// tokens are the same exactly when JavaScript's `===` says so.

/// Maps token norms to dense ids. Not Sendable: one interner per task.
public final class TokenInterner {
  private var norms: [String] = []
  private var byNorm: [CodeUnitKey: TokenID] = [:]
  private var byRaw: [CodeUnitKey: TokenID] = [:]

  public init() {}

  /// The number of distinct norms interned.
  public var count: Int { norms.count }

  /// The norm (folded token) of `id`.
  public func norm(_ id: TokenID) -> String { norms[Int(id.rawValue)] }

  /// The id of an already-folded norm, interning it when new.
  public func intern(norm: String) -> TokenID {
    let key = CodeUnitKey(norm)
    if let id = byNorm[key] { return id }
    let id = TokenID(rawValue: UInt32(norms.count))
    norms.append(norm)
    byNorm[key] = id
    return id
  }

  /// The id of the fold of a raw token span; each distinct raw form is folded once.
  func intern(raw units: UnsafeBufferPointer<UInt16>) -> TokenID {
    var ascii = true
    for u in units where u >= 0x80 { ascii = false; break }
    if ascii { return intern(norm: Fold.fold(units: units)) }
    let key = CodeUnitKey(units)
    if let id = byRaw[key] { return id }
    let id = intern(norm: Fold.fold(units: units))
    byRaw[key] = id
    return id
  }
}

/// A dense token id; `TokenInterner.norm(_:)` gives its folded form.
public struct TokenID: RawRepresentable, Hashable, Sendable {
  public let rawValue: UInt32
  public init(rawValue: UInt32) { self.rawValue = rawValue }
}

/// A string key with JavaScript equality (same UTF-16 code units), unlike `String`'s canonical equivalence.
struct CodeUnitKey: Hashable {
  let units: [UInt16]
  init(_ s: String) { units = Array(s.utf16) }
  init(_ u: UnsafeBufferPointer<UInt16>) { units = Array(u) }
}
