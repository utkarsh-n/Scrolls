// OWNER: N0
// G1 exact comparisons of the date ports: day math, the §5.3 grammar, labels and bins (IOS-SPEC §1.3, §2.2).

import Foundation
import ScrollsCore
import Testing

@Suite("G1 date goldens")
struct DateGoldenTests {
  /// The reference's test clock: 2026-10-04T12:00:00Z.
  static let now = DayMath.dayFromYMD(2026, 10, 4)

  @Test("g1.daymath: ymdFromDay every 97th day of [-10000, 3000], dayFromYMD rollovers, leap years and month lengths")
  func dayMath() throws {
    let fam = try Golden.load("g1.daymath")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      if let sweep = c["sweep"] {
        let from = sweep["from"]!.int!, step = sweep["step"]!.int!
        let packed = c["packed"]!.ints!
        var bad: Int? = nil
        for (i, p) in packed.enumerated() {
          let (y, m, d) = DayMath.ymdFromDay(from + i * step)
          let mine = y * 10000 + (y < 0 ? -1 : 1) * (m * 100 + d)
          if mine != p || DayMath.dayFromYMD(y, m, d) != from + i * step { bad = from + i * step; break }
        }
        report.check(bad == nil, "sweep from \(from), first bad day \(bad.map(String.init) ?? "-")", expected: .null, actual: .null)
      } else if let ymd = c["ymd"]?.ints {
        let got = DayMath.dayFromYMD(ymd[0], ymd[1], ymd[2])
        report.check(got == c["day"]!.int!, "dayFromYMD\(ymd)", expected: c["day"]!, actual: .number(Double(got)))
      } else if let y = c["year"]?.int {
        let months = (1...12).map { DayMath.daysInMonth(y, $0) }
        report.check(DayMath.isLeapYear(y) == c["leap"]!.boolValue! && months == c["months"]!.ints!, "year \(y)", expected: c,
                     actual: .array(months.map { .number(Double($0)) }))
      }
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.dates: parseDate over every distinct raw date of the snapshot, the reference's tests, §5.3 and fuzz")
  func dates() throws {
    let fam = try Golden.load("g1.dates")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      let raw: String? = switch c["raw"]! {
      case .string("$undefined"): nil
      case .string(let s): s
      case .number(let n): JSNumber.format(n)
      default: nil
      }
      var ctx = DateContext(now: Self.now)
      if let o = c["opts"]?.objectValue {
        if let v = o["twoDigitCentury"]?.int { ctx.twoDigitCentury = v }
        if o["zeroIsUnknown"] == .bool(true) { ctx.zeroIsUnknown = true }
        if o["negativeYearConvention"] == .string("astronomical") { ctx.negativeYearConvention = .astronomical }
        if let v = o["circaRadius"]?.int { ctx.circaRadius = v }
        if let v = o["openRangeYears"]?.int { ctx.openRangeYears = v }
      }
      let got = DateGrammar.parse(raw, context: ctx).jsonValue
      report.check(sameJSON(got, c["out"]!), "\(raw.debugDescription) \(c["opts"].map(CanonicalJSON.string) ?? "")",
                   expected: c["out"]!, actual: got)
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.date-labels: yearLabel, yearRangeLabel, fromInterval, fromDayInterval and formatDateLabel")
  func labels() throws {
    let fam = try Golden.load("g1.date-labels")
    let report = Golden.Report(fam.name)
    var outOfDomain = 0
    for c in fam.cases {
      let args = c["args"]!.arrayValue!
      switch c["fn"]!.stringValue! {
      case "yearLabel":
        let got = DateLabels.yearLabel(args[0].int!)
        report.check(same(got, c["out"]!.stringValue!), "yearLabel(\(args[0].int!))", expected: c["out"]!, actual: .string(got))
      case "yearRangeLabel":
        let got = DateLabels.yearRangeLabel(args[0].int, args[1].int)
        report.check(same(got, c["out"]!.stringValue!), "yearRangeLabel", expected: c, actual: .string(got))
      case "fromInterval":
        guard let lo = args[0].int, let hi = args[1].int else { outOfDomain += 1; continue }  // a JS non-integer year
        let o = args[2]
        do {
          let p = try DateGrammar.fromInterval(lo, hi, precision: o["precision"]?.stringValue, basis: o["basis"]?.stringValue,
                                               rule: o["rule"]!.stringValue!, approx: o["approx"]?.int == 1)
          report.check(c["out"].map { sameJSON(p.jsonValue, $0) } ?? false, "fromInterval\(CanonicalJSON.string(c["args"]!))",
                       expected: c["out"] ?? .null, actual: p.jsonValue)
        } catch {
          report.check(c["error"]?.stringValue.map { same($0, error.message) } ?? false, "fromInterval error",
                       expected: c["error"] ?? .null, actual: .string(error.message))
        }
      case "fromDayInterval":
        let o = args[2]
        let p = try DateGrammar.fromDayInterval(args[0].int!, args[1].int!, precision: o["precision"]!.stringValue!,
                                                basis: o["basis"]!.stringValue!, rule: o["rule"]!.stringValue!,
                                                raw: o["raw"]?.stringValue, approx: o["approx"]?.int == 1)
        report.check(sameJSON(p.jsonValue, c["out"]!), "fromDayInterval\(CanonicalJSON.string(c["args"]!))", expected: c["out"]!,
                     actual: p.jsonValue)
      case "formatDateLabel":
        let got = DateLabels.formatDateLabel(nil)
        report.check(same(got, c["out"]!.stringValue!), "formatDateLabel(null)", expected: c["out"]!, actual: .string(got))
      default:
        report.check(false, "unknown fn", expected: c, actual: .null)
      }
    }
    report.write()
    #expect(outOfDomain == 1, "one golden case passes a non-integer year, which the Swift API cannot express")
    #expect(report.passed, "\(report.summary)")
  }

  @Test("g1.bins: binOf, fits, fitsDays, monthBinOfDay and tierForPpy")
  func bins() throws {
    let fam = try Golden.load("g1.bins")
    let report = Golden.Report(fam.name)
    for c in fam.cases {
      let args = c["args"]!.arrayValue!
      switch c["fn"]!.stringValue! {
      case "binOf":
        do {
          let got = try Bins.binOf(year: args[0].int!, rawLevel: args[1].int!)
          report.check(c["out"]?.int == got, "binOf\(CanonicalJSON.string(c["args"]!))", expected: c, actual: .number(Double(got)))
        } catch {
          report.check(c["error"]?.stringValue.map { same($0, error.message) } ?? false, "binOf error", expected: c,
                       actual: .string(error.message))
        }
      case "fits":
        let got = try Bins.fitsChecked(args[0].int!, args[1].int!, Level(rawValue: args[2].int!)!)
        report.check(got == c["out"]!.boolValue!, "fits\(CanonicalJSON.string(c["args"]!))", expected: c["out"]!, actual: .bool(got))
      case "fitsDays":
        let got = try Bins.fitsDays(args[0].int!, args[1].int!, Level(rawValue: args[2].int!)!)
        report.check(got == c["out"]!.boolValue!, "fitsDays\(CanonicalJSON.string(c["args"]!))", expected: c["out"]!, actual: .bool(got))
      case "monthBinOfDay":
        let got = Bins.monthBinOfDay(args[0].int!)
        report.check(got == c["out"]!.int!, "monthBinOfDay(\(args[0].int!))", expected: c["out"]!, actual: .number(Double(got)))
      case "tierForPpy":
        let got = Bins.tierForPpy(args[0].numberValue!)
        report.check(got == c["out"]!.stringValue!, "tierForPpy", expected: c, actual: .string(got))
      default:
        report.check(false, "unknown fn", expected: c, actual: .null)
      }
    }
    report.write()
    #expect(report.passed, "\(report.summary)")
  }
}
