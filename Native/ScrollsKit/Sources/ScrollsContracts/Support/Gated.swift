// OWNER: N0
// SPEC §13 rule 7 as a type: a measure that fails its minimum-evidence gate carries no numeral. `Gated<Value>` is an
// enum with no numeric accessor; callers pattern-match, and a `.gated` case can only write null where the value would be.

import ScrollsCore

/// A gate code of `vocab.GATE_CODES` ('ok', 'insufficient_occurrences', …). Open, so a newer code still decodes.
public struct GateCode: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(rawValue)
  }
  public var description: String { rawValue }

  public static let ok = GateCode(rawValue: "ok")
  public static let insufficientOccurrences = GateCode(rawValue: "insufficient_occurrences")
  public static let insufficientDocuments = GateCode(rawValue: "insufficient_documents")
  public static let insufficientAuthors = GateCode(rawValue: "insufficient_authors")
  public static let insufficientCoverage = GateCode(rawValue: "insufficient_coverage")
  public static let singleSource = GateCode(rawValue: "single_source")
  public static let unaligned = GateCode(rawValue: "unaligned")
  public static let sliceTooSmall = GateCode(rawValue: "slice_too_small")
  public static let compositionMismatch = GateCode(rawValue: "composition_mismatch")
  public static let modalityMismatch = GateCode(rawValue: "modality_mismatch")
  public static let samplingDesign = GateCode(rawValue: "sampling_design")
  public static let noClusterStructure = GateCode(rawValue: "no_cluster_structure")
  public static let notRun = GateCode(rawValue: "not_run")

  /// Every code of `Vocab.gateCodes`, in vocab order.
  public static var all: [GateCode] { Vocab.gateCodes.map(GateCode.init(rawValue:)) }
}

/// Why a value is withheld: the gate that failed, what it needs, what the slice has, and the widening that would pass
/// it (`suggestion` null when no widening inside the corpus reaches the gate). It holds no estimate by construction.
/// Sentences about the gate (`note`, `reason`) belong to the enclosing object, which carries them in both states.
public struct Gate: Sendable, Equatable {
  public var code: GateCode
  public var needed: JSONValue
  public var have: JSONValue
  public var suggestion: JSONValue
  /// The keys this gated object writes as null in place of its numerals ("value", "ci", …), in the value type's order.
  public var nullKeys: [String]

  public init(code: GateCode, needed: JSONValue, have: JSONValue, suggestion: JSONValue = .null, nullKeys: [String]) {
    precondition(code != .ok, "a Gate is a failed gate; use Gated.value for 'ok'")
    self.code = code
    self.needed = needed
    self.have = have
    self.suggestion = suggestion
    self.nullKeys = nullKeys
  }
}

/// A value type that can be withheld by a gate. Its Codable writes the keys of the passing case; `nullKeysWhenGated`
/// names the keys a gated object writes as null instead (contract: `value`, `ci`, …).
public protocol GatedValue: Codable, Sendable, Equatable {
  static var nullKeysWhenGated: [String] { get }
}

/// A gated value. Codable flattens into the enclosing object: `{gate: "ok", …Value's keys}` or
/// `{gate: <code>, needed, have, suggestion, <null keys>: null}`. There is no accessor that returns a number.
public enum Gated<Value: GatedValue>: Sendable, Equatable {
  case value(Value)
  case gated(Gate)

  /// "ok" for `.value`, the failed gate's code otherwise.
  public var code: GateCode {
    switch self {
    case .value: .ok
    case .gated(let g): g.code
    }
  }

  /// True when the gate passed.
  public var isOK: Bool { if case .value = self { true } else { false } }
}

extension Gated: Codable {
  private enum Keys: String, CodingKey { case gate, needed, have, suggestion }

  /// Reads the enclosing object's `gate` key and the matching case. Call it with the enclosing object's decoder.
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    let code = try c.decode(GateCode.self, forKey: .gate)
    if code == .ok {
      self = .value(try Value(from: decoder))
      return
    }
    let all = try decoder.container(keyedBy: WireKey.self)
    let nulls = try Value.nullKeysWhenGated.filter { k in
      let key = WireKey(ScrollsJSON.camelCase(k))
      return all.contains(key) ? try all.decodeNil(forKey: key) : false
    }
    self = .gated(Gate(code: code, needed: try c.decode(JSONValue.self, forKey: .needed),
                       have: try c.decode(JSONValue.self, forKey: .have),
                       suggestion: try c.decode(JSONValue.self, forKey: .suggestion), nullKeys: nulls))
  }

  /// Writes into the enclosing object's container. Call it with the enclosing object's encoder.
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .value(let v):
      try c.encode(GateCode.ok, forKey: .gate)
      try v.encode(to: encoder)
    case .gated(let g):
      try c.encode(g.code, forKey: .gate)
      try c.encode(g.needed, forKey: .needed)
      try c.encode(g.have, forKey: .have)
      try c.encode(g.suggestion, forKey: .suggestion)
      var all = encoder.container(keyedBy: WireKey.self)
      for k in g.nullKeys { try all.encodeNil(forKey: WireKey(ScrollsJSON.camelCase(k))) }
    }
  }
}
