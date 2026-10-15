// OWNER: N4
// Compare on the phone (IOS-SPEC §4.10, §8.5 N4): the request built from the view it was opened from (expression
// strands, filters, toggles, the as-saved pins), A always the earlier slice, a gate's [Apply] widening, and SPEC §13
// rule 7 — a gated payload renders no numeral — by type (a gated part is a `CompareGate`, built from the gate alone) and
// by a UI text scan: every string the screen draws (the content the panels render, and the accessibility text of the
// hosted panels) is searched for the estimates a gated object carried. The payloads are the contract fixtures' real
// variants (MockAtlas) plus a hand-made one that smuggles numerals into every gated object.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsService
import SwiftUI
import Testing
import UIKit

@testable import Scrolls

@MainActor
@Suite("Compare: requests, gates and the no-numeral rule")
struct CompareTests {
  // MARK: fixtures

  static func payload(_ variant: String) async throws -> CompareResponse {
    let atlas = MockAtlas(variant: ["compare": variant])
    let req = CompareRequest(expr: [ExpressionID(12)], a: CompareSlice(years: [1955, 1985], f: "syn:1"),
                             b: CompareSlice(years: [1994, 2026], f: "syn:1"))
    return try await atlas.compare(req)
  }

  static let variants = ["ok", "gated", "modality_mismatch", "drift_not_run", "drift_ok", "freq_gated", "collocates_not_run",
                         "baseline_rho_ok", "baseline_rho_gated"]

  /// The estimate keys a gated object must not show; collected from a payload's gated objects (their numbers).
  static func smuggledNumbers(in v: JSONValue) -> [Double] {
    var out: [Double] = []
    func walk(_ v: JSONValue) {
      switch v {
      case .object(let o):
        if CompareGate.isGated(v) {
          for k in ["value", "ci", "rate", "mean", "share", "jaccard", "percentile", "ratio"] {
            if case .number(let x)? = o[k] { out.append(x) }
            if case .array(let a)? = o[k] { out += a.compactMap(\.numberValue) }
          }
        }
        o.values.forEach(walk)
      case .array(let a): a.forEach(walk)
      default: break
      }
    }
    walk(v)
    return out
  }

  /// Every way the screen could print a number: count, number at 2 and 3 significant digits, rate styles, share.
  static func renderings(_ x: Double) -> [String] {
    var r = [Format.number(x), Format.number(x, sig: 2), Format.share(x), JSNumber.format(x), JSNumber.toFixed(x, 2)]
    if abs(x) >= 1 { r.append(Format.count(x)) }
    for unit in ["per_million_tokens", "per_thousand_works"] { r.append(Format.rate(x, unit: unit)) }
    return r.filter { $0 != Format.dash && $0.count >= 4 }
  }

  /// A payload with a numeral smuggled into every gated object (the engine never sends one; the screen must not show it).
  static func smuggled() async throws -> CompareResponse {
    var json = try ScrollsJSON.value(try await payload("freq_gated"))
    func poison(_ v: JSONValue) -> JSONValue {
      switch v {
      case .object(var o):
        if CompareGate.isGated(v) {
          o["value"] = .number(987.654321)
          o["ci"] = [.number(876.54321), .number(1987.6543)]
          o["rate"] = .number(76543.21)
          o["mean"] = .number(0.765432)
        }
        for k in o.keys where k != "value" && k != "ci" && k != "rate" && k != "mean" { o[k] = poison(o[k]!) }
        return .object(o)
      case .array(let a): return .array(a.map(poison))
      default: return v
      }
    }
    json = poison(json)
    // gate every measure and the collocates too
    if var o = json.objectValue {
      o["collocates"] = ["gate": "insufficient_occurrences", "value": 0.4321, "needed": ["occurrences": 20], "have": ["a": 12, "b": 3],
                         "suggestion": .null, "note": "Too few occurrences (12 and 3; needs 20). Showing KWIC."]
      o["tone"] = ["gate": "not_run", "mean": 0.2468, "needed": ["adapter": "nl"], "have": ["adapter": .null], "suggestion": .null]
      json = .object(o)
    }
    return try ScrollsJSON.decode(CompareResponse.self, from: json)
  }

  // MARK: requests

  @Test("the request comes from the view: expression strands (two at most), the global filter, toggles; A is the earlier slice")
  func requestFromView() {
    var s = ViewState.defaultState("demo")
    s.strands = [
      .init(type: "expression", id: .number(3), variants: .default, glyph: "▲"),
      .init(type: "work", id: .number(9), variants: .default, glyph: "●"),
      .init(type: "expression", id: .number(1), variants: .default, glyph: "■"),
      .init(type: "expression", id: .number(2), variants: .default, glyph: "◆"),
    ]
    s.f.kind = ["song"]
    s.toggles["tr"] = 1
    let seed = CompareSeed(SliceSeed(fromYear: 1994, toYear: 2026), SliceSeed(fromYear: 1955, toYear: 1985), viewHash: s.hash)
    let m = CompareModel(seed: seed, atlas: nil, fixtures: true)
    let r = m.request!
    #expect(r.expr == [ExpressionID(3), ExpressionID(1)])
    #expect(r.a.years == [1955, 1985] && r.b.years == [1994, 2026])
    #expect(r.a.f == "kind:song" && r.b.f == "kind:song")
    #expect(r.toggles?["tr"] == 1)
    #expect(r.measures == CompareModel.allMeasures)
    #expect(r.runs == nil && r.cutoffs == nil && r.override == nil)
  }

  @Test("as saved: the view's pinned counting runs of the compared expressions and its clustering run go with the request (RF-2)")
  func asSavedPins() {
    var s = ViewState.defaultState("demo")
    s.strands = [.init(type: "expression", id: .number(1), variants: .default, glyph: "■")]
    s.runs = .init(materialize: [1: 12, 7: 99], cluster: 5, quotes: nil, vectors: nil)
    s.asSaved = true
    let seed = CompareSeed(SliceSeed(fromYear: 1955, toYear: 1985), SliceSeed(fromYear: 1994, toYear: 2026), viewHash: s.hash)
    let r = CompareModel(seed: seed, atlas: nil, fixtures: true).request!
    #expect(r.runs?.materialize == ["1": 12])
    #expect(r.runs?.cluster == RunID(5))
  }

  @Test("no expression strand: nothing is compared, the screen asks for one")
  func needsExpression() async {
    let seed = CompareSeed(SliceSeed(fromYear: 1955, toYear: 1985), SliceSeed(fromYear: 1994, toYear: 2026),
                           viewHash: ViewState.defaultState("demo").hash)
    let m = CompareModel(seed: seed, atlas: MockAtlas(), fixtures: true)
    #expect(m.request == nil)
    await m.run()
    #expect(m.phase == .needsExpression)
  }

  @Test("[Apply] widens the slices a suggestion names, and A stays the earlier one")
  func applyWidening() {
    let s: JSONValue = ["label": "Widen A to 1890–1950", "a": ["years": [1890, 1950], "f": ""], "would_have": [:]]
    let edit = SliceEdit(suggestion: s)
    #expect(edit?.a == SliceSeed(fromYear: 1890, toYear: 1950, filter: ""))
    #expect(edit?.b == nil)
    #expect(SliceEdit(suggestion: ["label": "Build token streams", "run": ["stage": "tokstream"]]) == nil)
    let ordered = CompareSeed(SliceSeed(fromYear: 2000, toYear: 2010), SliceSeed(fromYear: 1900, toYear: 1950), viewHash: "")
    #expect(ordered.a.fromYear == 1900)
  }

  // MARK: content from every fixture variant

  @Test("every fixture variant: each gated object becomes a gate card, and no estimate a gated object holds is drawn")
  func variantsByType() async throws {
    for v in Self.variants {
      let p = try await Self.payload(v)
      let c = CompareContent(p, aYears: [1955, 1985], bYears: [1994, 2026], label: "carry the zero")
      let json = try ScrollsJSON.value(p)
      // gated objects in the payload ↔ gate cards on the screen
      var gatedInPayload = 0
      if CompareGate.isGated(json["freq"]) { gatedInPayload += 1 }
      for k in ["a", "b", "rate_ratio"] where CompareGate.isGated(json["freq"]?[k]) { gatedInPayload += 1 }
      for k in ["collocates", "clusters", "tone"] where CompareGate.isGated(json[k]) { gatedInPayload += 1 }
      if CompareGate.isGated(json["baseline_rho"]) { gatedInPayload += 1 }
      gatedInPayload += p.measures.filter { !$0.result.isOK }.count
      let modalityCard = c.coverage.modalityGate != nil && !CompareGate.isGated(json["freq"]) ? 1 : 0
      #expect(c.gates.count == gatedInPayload + modalityCard, "\(v): \(c.gates.map(\.id))")
      // the text scan over the content
      let all = c.allStrings.joined(separator: "\n")
      for x in Self.smuggledNumbers(in: json) {
        for r in Self.renderings(x) { #expect(!all.contains(r), "\(v): '\(r)' of a gated object is on the screen") }
      }
    }
  }

  @Test("a gated frequency side shows its counts and the card, never a rate, interval or dispersion")
  func gatedFrequencySide() async throws {
    let c = CompareContent(try await Self.payload("freq_gated"), aYears: [1906, 1906], bYears: [1994, 2026], label: nil)
    guard case .shown(let sides, let ratio, _, _, _) = c.frequency else {
      Issue.record("frequency is not shown")
      return
    }
    guard case .gated(_, let counts, let gate) = sides[0] else {
      Issue.record("slice A is not gated")
      return
    }
    #expect(counts.hasSuffix("matches") || counts.contains("documents"))
    #expect(gate.gate.code == .insufficientCoverage)
    if case .gated = ratio {} else { Issue.record("the rate ratio is not gated") }
    if case .rate = sides[1] {} else { Issue.record("slice B lost its rate") }
  }

  @Test("UI text scan: numerals smuggled into every gated object never reach the content or the hosted panels")
  func smuggledNumeralsNeverShown() async throws {
    let p = try await Self.smuggled()
    let c = CompareContent(p, aYears: [1906, 1906], bYears: [1994, 2026], label: "carry the zero")
    let banned = ["987.654321", "987.65", "988", "876.54321", "876.5", "877", "1,987.65", "1,988", "76,543", "76543", "0.765", "0.77",
                  "0.4321", "0.432", "0.2468", "0.247", "98,765", "98.8%", "87,654"]
    let text = c.allStrings.joined(separator: "\n")
    for b in banned { #expect(!text.contains(b), "content shows '\(b)'") }
    // and in the panels as drawn: the hosted view's accessibility text
    let shown = Self.hostedText(ComparePanels(content: c))
    #expect(!shown.isEmpty, "the hosted panels exposed no text")
    for b in banned { #expect(!shown.contains(b), "screen shows '\(b)'") }
  }

  @Test("the modality refusal: a cross-media comparison shows the refusal card and Compare anyway, with no rate")
  func modalityRefusal() async throws {
    let c = CompareContent(try await Self.payload("modality_mismatch"), aYears: [1800, 1899], bYears: [1900, 1999], label: "machine")
    #expect(c.coverage.modalityGate?.gate.code == .modalityMismatch)
    if case .gated = c.frequency {} else { Issue.record("frequency is not refused") }
  }

  // MARK: hosting

  /// The accessibility text of a hosted SwiftUI view (labels and values of every element, recursively).
  static func hostedText<V: View>(_ view: V) -> String {
    let host = UIHostingController(rootView: ScrollView { view.padding(16) }.environment(\.colorScheme, .dark))
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 430, height: 4000))
    window.rootViewController = host
    window.makeKeyAndVisible()
    host.view.frame = window.bounds
    host.view.setNeedsLayout()
    host.view.layoutIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    var out: [String] = []
    func walk(_ e: Any, depth: Int) {
      guard depth < 40 else { return }
      if let o = e as? NSObject {
        if let l = o.accessibilityLabel, !l.isEmpty { out.append(l) }
        if let v = o.accessibilityValue, !v.isEmpty { out.append(v) }
        if let kids = o.accessibilityElements { for k in kids { walk(k, depth: depth + 1) } }
        let n = o.accessibilityElementCount()
        if n != NSNotFound, n > 0 { for i in 0..<n { if let k = o.accessibilityElement(at: i) { walk(k, depth: depth + 1) } } }
      }
      if let v = e as? UIView { for s in v.subviews { walk(s, depth: depth + 1) } }
    }
    walk(host.view as Any, depth: 0)
    window.isHidden = true
    return out.joined(separator: "\n")
  }
}
