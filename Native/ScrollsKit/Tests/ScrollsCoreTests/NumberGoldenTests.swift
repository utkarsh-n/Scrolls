// OWNER: N0
// G1 exact comparisons of the number ports: Number::toString, toFixed/toPrecision, Math.round/log/log10, canonical JSON,
// mulberry32, format.mjs, ids.mjs and localeCompare('en') (IOS-SPEC §1.7, §2.2).

import Foundation
import ScrollsCore
import Testing

@Suite("G1 number and id goldens")
struct NumberGoldenTests {
  @Test("g1.jsnumber: Number::toString of 20,000 doubles and the edge cases")
  func numberToString() throws {
    let fam = try Golden.load("g1.jsnumber")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      let x = c["b"]!.hexDouble!
      let got = JSNumber.format(x)
      report.check(got == c["s"]!.stringValue!, c["b"]!.stringValue!, expected: c["s"]!, actual: .string(got))
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.js-math: Math.log10, Math.log and Math.round bit for bit; toFixed and toPrecision byte for byte")
  func jsMath() throws {
    let fam = try Golden.load("g1.js-math")
    let report = Golden.Report(fam.name)
    func bits(_ d: Double) -> String {
      let h = String(d.bitPattern, radix: 16)
      return String(repeating: "0", count: 16 - h.count) + h
    }
    for c in fam.cases {
      if let special = c["special"]?.stringValue {
        let x = c["negZero"] == .bool(true) ? -0.0 : Double(special) ?? .nan
        let got: JSONValue = ["round": .string(bits(JSNumber.round(x))), "toFixed2": .string(JSNumber.toFixed(x, 2)),
                              "toPrecision3": .string(JSNumber.toPrecision(x, 3)), "log10": .string(bits(JSMath.log10(x)))]
        var want = c
        if case .object(var o) = want { o["special"] = nil; o["negZero"] = nil; want = .object(o) }
        // NaN payloads are not observable in JavaScript: compare NaN by kind
        let ok = sameJSON(got, want) || (x.isNaN && JSMath.log10(x).isNaN && sameJSON(got["toFixed2"]!, want["toFixed2"]!))
        report.check(ok, "special \(special)", expected: want, actual: got)
        continue
      }
      let x = c["bits"]!.hexDouble!
      let fixed = [0, 1, 2, 3, 6, 20].map { JSNumber.toFixed(x, $0) }
      let fixedNeg = [0, 1, 2].map { JSNumber.toFixed(-x, $0) }
      let precision = [1, 2, 3, 6, 12, 17, 21].map { JSNumber.toPrecision(x, $0) }
      let got: JSONValue = [
        "bits": c["bits"]!, "log10": .string(bits(JSMath.log10(x))), "log": .string(bits(JSMath.log(x))),
        "round": .string(bits(JSNumber.round(x))), "roundNeg": .string(bits(JSNumber.round(-x))),
        "toFixed": .array(fixed.map(JSONValue.string)), "toFixedNeg": .array(fixedNeg.map(JSONValue.string)),
        "toPrecision": .array(precision.map(JSONValue.string)),
      ]
      report.check(sameJSON(got, c), c["bits"]!.stringValue!, expected: c, actual: got)
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.canonical-json: JSON.parse then canonicalJson, byte for byte")
  func canonicalJSON() throws {
    let fam = try Golden.load("g1.canonical-json")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      let text = c["json"]!.stringValue!
      let got = (try? JSONValue.parse(text)).map(CanonicalJSON.string) ?? "<parse error>"
      report.check(same(got, c["canonical"]!.stringValue!), text, expected: c["canonical"]!, actual: .string(got))
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.mulberry32: the seeded streams, bit for bit")
  func mulberry() throws {
    let fam = try Golden.load("g1.mulberry32")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      let seed = JSNumber.toUint32(c["seed"]!.numberValue!)
      var rng = Mulberry32(seed: seed)
      let draws = (0..<c["draws"]!.arrayValue!.count).map { _ in rng.next() }
      let ok = Int(seed) == c["uint32"]!.int! && draws == c["draws"]!.arrayValue!.map { $0.numberValue! }
      report.check(ok, "seed \(JSNumber.format(c["seed"]!.numberValue!))", expected: c["uint32"]!, actual: .number(Double(seed)))
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.format: formatCount/Number/Tokens/Share/Rate/CI, unitLabel, totalsText and refWords")
  func format() throws {
    let fam = try Golden.load("g1.format")
    let report = Golden.Report(fam.name)
    func number(_ v: JSONValue?) -> Double? {
      switch v {
      case .number(let n)?: n
      case .string("NaN")?: .nan
      case .string("Infinity")?: .infinity
      case .string("-Infinity")?: -.infinity
      default: nil
      }
    }
    for c in fam.cases {
      switch c["fn"]!.stringValue! {
      case "numbers":
        let x = number(c["x"])
        let got: JSONValue = ["fn": "numbers", "x": c["x"]!, "count": .string(Format.count(x)), "number": .string(Format.number(x)),
                              "tokens": .string(Format.tokens(x)), "share": .string(Format.share(x))]
        report.check(sameJSON(got, c), "numbers \(CanonicalJSON.string(c["x"]!))", expected: c, actual: got)
      case "formatNumber":
        let got = Format.number(number(c["x"]), sig: c["sig"]!.int!)
        report.check(same(got, c["out"]!.stringValue!), "formatNumber", expected: c, actual: .string(got))
      case "unitLabel":
        let got = Format.unitLabel(c["unit"]!.stringValue)
        report.check(same(got, c["out"]!.stringValue!), "unitLabel", expected: c, actual: .string(got))
      case "formatRate":
        let got = Format.rate(number(c["x"]), unit: c["unit"]!.stringValue)
        report.check(same(got, c["out"]!.stringValue!), "formatRate", expected: c, actual: .string(got))
      case "formatCI":
        let ci = c["ci"]!.arrayValue.map { $0.map { number($0) } }
        let got = Format.ci(ci, unit: c["unit"]!.stringValue)
        report.check(same(got, c["out"]!.stringValue!), "formatCI", expected: c, actual: .string(got))
      case "totalsText":
        let t = c["totals"]!
        let totals: Format.Totals? = t.isNull ? nil : Format.Totals(
          n: t["n"]!.numberValue!,
          byUnit: t["by_unit"].map { (matches: $0["matches"]!.numberValue!, works: $0["works"]!.numberValue!) },
          unitsMixed: t["units_mixed"] == .bool(true))
        let got = Format.totalsText(totals)
        report.check(same(got, c["out"]!.stringValue!), "totalsText", expected: c, actual: .string(got))
      case "refWords":
        let got = Format.refWords(c["ref"]!.stringValue)
        report.check(same(got, c["out"]!.stringValue!), "refWords", expected: c, actual: .string(got))
      default:
        report.check(false, "unknown fn", expected: c, actual: .null)
      }
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.ids: fnv1a32, shortHash, slugify, ref and parseRef")
  func ids() throws {
    let fam = try Golden.load("g1.ids")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      switch c["fn"]!.stringValue! {
      case "fnv1a32":
        let got = IDs.fnv1a32(c["s"]!.stringValue!)
        report.check(Int(got) == c["out"]!.int!, "fnv1a32", expected: c, actual: .number(Double(got)))
      case "shortHash":
        let got = IDs.shortHash(c["s"]!.stringValue!, length: c["n"]!.int!)
        report.check(got == c["out"]!.stringValue!, "shortHash", expected: c, actual: .string(got))
      case "slugify":
        let got = IDs.slug(c["s"]!.stringValue!, max: c["max"]!.int!)
        report.check(same(got, c["out"]!.stringValue!), "slugify", expected: c, actual: .string(got))
      case "parseRef":
        let got: JSONValue
        if let r = try? IDs.parseRef(c["s"]!.stringValue!) {
          let id: JSONValue = switch r.id {
          case .number(let n): .number(Double(n))
          case .string(let s): .string(s)
          }
          got = ["type": .string(r.type), "id": id]
        } else {
          got = .null
        }
        let ok = c["error"]!.isNull ? sameJSON(got, c["out"]!) : got.isNull
        report.check(ok, "parseRef \(c["s"]!.stringValue!)", expected: c, actual: got)
      case "ref":
        let args = c["args"]!.arrayValue!
        let got: String? = switch args[1] {
        case .number(let n): try? IDs.ref(args[0].stringValue!, Int64(n))
        case .string(let s): try? IDs.ref(args[0].stringValue!, s)
        default: nil
        }
        let ok = c["error"]!.isNull ? got.map { same($0, c["out"]!.stringValue!) } ?? false : got == nil
        report.check(ok, "ref", expected: c, actual: got.map(JSONValue.string) ?? .null)
      default:
        report.check(false, "unknown fn", expected: c, actual: .null)
      }
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.collation: ReferenceCollation = localeCompare(…, 'en') (DV-4)")
  func collation() throws {
    let fam = try Golden.load("g1.collation")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      let got = ReferenceCollation.compare(c["a"]!.stringValue!, c["b"]!.stringValue!).rawValue
      report.check(got == c["cmp"]!.int!, "\(c["a"]!.stringValue!.debugDescription) vs \(c["b"]!.stringValue!.debugDescription)",
                   expected: c["cmp"]!, actual: .number(Double(got)))
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }
}
