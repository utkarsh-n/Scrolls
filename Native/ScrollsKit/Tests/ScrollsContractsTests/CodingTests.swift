// OWNER: N0
// The coding conventions every contract type relies on: the key strategies, key presence (absent · null · value),
// verbatim JSONValue keys, typed ids and the Gated flattening.

import Foundation
import ScrollsContracts
import ScrollsCore
import Testing

private struct Presence: Codable, Equatable {
  var plain: Int?
  @Nullable var required: String?
  @NullOrAbsent var optional: String?
  var opaque: JSONValue
  var loDay: Int
}

private struct CamelKeys: Codable, Equatable {
  var dataVersion: Int
  var laneState: String
  var after1928: Int
  enum CodingKeys: String, WireNamedKeys {
    case dataVersion, laneState, after1928
    static let wireNames = ["dataVersion": "dataVersion", "after1928": "after_1928"]
  }
}

private struct Rate: GatedValue {
  var value: Double
  var ci: [Double]
  var text: String
  static let nullKeysWhenGated = ["value", "ci"]
}

private struct Measured: Codable, Equatable {
  var metric: String
  var result: Gated<Rate>
  enum Keys: String, CodingKey { case metric }
  init(metric: String, result: Gated<Rate>) {
    self.metric = metric
    self.result = result
  }
  init(from decoder: any Decoder) throws {
    metric = try decoder.container(keyedBy: Keys.self).decode(String.self, forKey: .metric)
    result = try Gated(from: decoder)
  }
  func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(metric, forKey: .metric)
    try result.encode(to: encoder)
  }
}

private func roundTrip<T: Codable>(_ type: T.Type, _ json: String) throws -> String {
  let v = try ScrollsJSON.decode(type, from: Data(json.utf8))
  return try ScrollsJSON.canonical(v)
}

private func canonical(_ json: String) throws -> String { CanonicalJSON.string(try JSONValue.parse(json)) }

@Suite("Contract coding conventions")
struct CodingTests {
  @Test("snake_case ↔ camelCase conversion is ASCII and inverts on contract keys")
  func keyConversion() {
    #expect(ScrollsJSON.snakeCase("queryKey") == "query_key")
    #expect(ScrollsJSON.snakeCase("loDay") == "lo_day")
    #expect(ScrollsJSON.snakeCase("sha256") == "sha256")
    #expect(ScrollsJSON.camelCase("lo_day") == "loDay")
    #expect(ScrollsJSON.camelCase("value_excerpt") == "valueExcerpt")
    #expect(ScrollsJSON.camelCase("dataVersion") == "dataVersion")
    #expect(ScrollsJSON.camelCase("_x") == "_x")
    #expect(ScrollsJSON.camelCase("a__b") == "a__b")
    #expect(ScrollsJSON.camelCase("after_1928") == "after1928")
  }

  @Test("absent, null and value survive a round trip; required nullable keys are written as null")
  func presence() throws {
    let cases = [
      #"{"required":null,"opaque":null,"lo_day":3}"#,
      #"{"plain":1,"required":"r","optional":null,"opaque":{"a_b":[1,null]},"lo_day":-4}"#,
      #"{"required":null,"optional":"o","opaque":"x","lo_day":0}"#,
    ]
    for json in cases { #expect(try roundTrip(Presence.self, json) == canonical(json)) }
    let made = Presence(plain: nil, required: nil, optional: nil, opaque: .null, loDay: 1)
    #expect(try ScrollsJSON.canonical(made) == #"{"lo_day":1,"opaque":null,"required":null}"#)
    var explicit = made
    explicit.$optional = .null
    #expect(try ScrollsJSON.canonical(explicit) == #"{"lo_day":1,"opaque":null,"optional":null,"required":null}"#)
  }

  @Test("camelCase and digit keys go through WireNamedKeys")
  func wireNames() throws {
    let json = #"{"dataVersion":4,"lane_state":"ok","after_1928":2}"#
    #expect(try roundTrip(CamelKeys.self, json) == canonical(json))
  }

  @Test("JSONValue and String-keyed dictionaries keep their keys verbatim")
  func verbatimKeys() throws {
    struct Holder: Codable, Equatable {
      var someMap: [String: Int]
      var blob: JSONValue
    }
    let json = #"{"some_map":{"W_MIXED_LANGUAGE":1,"x_y":2,"camelKey":3},"blob":{"lo_day":1,"queryKey":{"a_b":2}}}"#
    #expect(try roundTrip(Holder.self, json) == canonical(json))
  }

  @Test("typed ids are bare JSON numbers")
  func ids() throws {
    let ids: [PassageID] = [901, PassageID(77)]
    #expect(try ScrollsJSON.canonical(ids) == "[901,77]")
    #expect(try ScrollsJSON.decode([DocumentID].self, from: Data("[3,4]".utf8)) == [3, 4])
  }

  @Test("Gated flattens into its object and a gated case writes only null in place of numerals")
  func gated() throws {
    let ok = #"{"metric":"m","gate":"ok","value":0.5,"ci":[0.1,0.9],"text":"t"}"#
    let gated = #"{"metric":"m","gate":"slice_too_small","value":null,"needed":{"tokens":3},"have":{"a":1},"suggestion":null}"#
    let bare = #"{"metric":"m","gate":"not_run","needed":{},"have":{},"suggestion":{"run":{"stage":"cluster"}}}"#
    for json in [ok, gated, bare] { #expect(try roundTrip(Measured.self, json) == canonical(json)) }
    let g = try ScrollsJSON.decode(Measured.self, from: Data(gated.utf8))
    #expect(g.result.code == .sliceTooSmall)
    guard case .gated(let gate) = g.result else { Issue.record("expected a gated value"); return }
    #expect(gate.nullKeys == ["value"])
    #expect(GateCode.all.map(\.rawValue) == Vocab.gateCodes)
  }

  @Test("the error body writes hint and detail even when empty")
  func errorBody() throws {
    let json = #"{"error":{"code":"E_NOT_FOUND","message":"Passage 3 not found.","hint":null,"detail":null}}"#
    #expect(try roundTrip(ErrorBody.self, json) == canonical(json))
    let e = ScrollsError.notImplemented(area: "search")
    #expect(e.status == 501)
    #expect(e.code == .notImplemented)
  }
}
