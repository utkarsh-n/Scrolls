// OWNER: N8
// The experience's logic, without the UI (IOS-SPEC §4.6, §4.8, §4.9, §4.15, §4.17, §4.21): deep-link routing, the bin
// id grammar, highlight segments at UTF-16 offsets, the contemporary window and its stratified rows, the transport's bin
// steps, state restoration's round trip, the search's typed actions and romanised matches, the filter cycle, the drawer's
// denominator line, the coach marks' words from data, the haptic map, and the SheetMode machine over MockAtlas.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsScrollModel
import ScrollsService
import Testing

@testable import Scrolls

@MainActor
@Suite("N8 experience logic")
struct N8ExperienceTests {
  // MARK: Deep links (§4.15, ΔS-18)

  @Test("scrolls://open#… carries a state in the web's grammar")
  func openLink() throws {
    let url = try #require(URL(string: "scrolls://open#v=1&c=demo&s=e12"))
    guard case .state(let hash) = DeepLinks.route(for: url) else { Issue.record("not a state route"); return }
    let s = ViewState.decodeHash(hash).state
    #expect(s.corpus == "demo")
    #expect(s.strands.map(\.id) == [.number(12)])
  }

  @Test("scrolls://view/<slug>[?as=1] and #view= open a saved view")
  func viewLinks() throws {
    #expect(DeepLinks.route(for: try #require(URL(string: "scrolls://view/carry-the-zero-3f9a"))) == .savedView(slug: "carry-the-zero-3f9a", asSaved: false))
    #expect(DeepLinks.route(for: try #require(URL(string: "scrolls://view/carry-the-zero-3f9a?as=1"))) == .savedView(slug: "carry-the-zero-3f9a", asSaved: true))
    #expect(DeepLinks.route(for: try #require(URL(string: "scrolls://open#view=x~2&as=1"))) == .savedView(slug: "x~2", asSaved: true))
  }

  @Test("files: views load, packs go to Sources, data files to Import, others are refused in words")
  func fileRoutes() {
    let dir = URL(fileURLWithPath: "/tmp/inbox")
    #expect(DeepLinks.route(for: dir.appending(path: "a.scrollsview")) == .viewFile(dir.appending(path: "a.scrollsview")))
    #expect(DeepLinks.route(for: dir.appending(path: "stemm.scrollspack")) == .packOrAtlas(dir.appending(path: "stemm.scrollspack")))
    #expect(DeepLinks.route(for: dir.appending(path: "letters.csv")) == .importFile(dir.appending(path: "letters.csv")))
    #expect(DeepLinks.route(for: dir.appending(path: "x.pdf")) == .unknown(DeepLinkCopy.unknownFile))
    #expect(DeepLinks.route(for: URL(string: "https://example.org/#v=1")!) == .unknown(DeepLinkCopy.unknownScheme))
  }

  @Test("a state's link round-trips through the router")
  func linkRoundTrip() throws {
    var s = ViewState.defaultState("demo")
    s.strands = [ViewState.Strand(type: "expression", id: .number(12), variants: .default, glyph: "")]
    s.selection = ViewState.Selection(type: "occurrence", id: .number(55012))
    s = s.canonicalized()
    let url = try #require(DeepLinks.link(for: s))
    guard case .state(let hash) = DeepLinks.route(for: url) else { Issue.record("not a state route"); return }
    #expect(ViewState.decodeHash(hash).state.hash == s.hash)
  }

  // MARK: Bins and the drawer

  @Test("bin ids: lane~strand~tier~bin, tiers L0–L5 only")
  func binIDs() {
    let b = BinRef(selectionID: "community:classroom~12~L2~191")
    #expect(b == BinRef(lane: "community:classroom", strand: "12", tier: "L2", bin: 191))
    #expect(b?.selectionID == "community:classroom~12~L2~191")
    #expect(BinRef(selectionID: "a~b~L6~1") == nil)
    #expect(BinRef(selectionID: "a~b~L2") == nil)
    #expect(BinRef(selectionID: "a~b~L2~x") == nil)
    #expect(BinRef(selectionID: "lane~1~L0~-3")?.bin == -3)
  }

  @Test("the drawer's denominator line: the engine's text, else built from its numbers")
  func denominatorLine() {
    #expect(ListRules.denominatorLine(["text": "n = 22 in 1910–1919 · 2.7k tokens"]) == "n = 22 in 1910–1919 · 2.7k tokens")
    let built = ListRules.denominatorLine(["n": 14, "label": "1910–1919", "tokens": 38120, "docs": 6])
    #expect(built.hasPrefix("n = 14 in 1910–1919 · "))
    #expect(built.contains("tokens"))
    #expect(built.contains("6 documents"))
    #expect(ListRules.denominatorLine(nil) == "")
  }

  // MARK: Highlights at UTF-16 offsets (D4)

  @Test("segments concatenate back to the text and mark the selected occurrence")
  func segments() {
    let text = "the ones they never counted hold the place for the number\ncarry the zero, carry the block"
    let hl = [Highlight(start: 58, end: 72, expr: 12, occ: 55012, variant: "carry the zero")]
    let segs = PassageSegments.segments(text, hl, selectedOcc: 55012)
    #expect(segs.map(\.text).joined() == text)
    let marks = segs.filter(\.mark)
    #expect(marks.count == 1)
    #expect(marks[0].text == "carry the zero")
    #expect(marks[0].selected)
  }

  @Test("highlights never split a surrogate pair, are clamped, and overlapping ones merge")
  func surrogates() {
    let text = "a😀b😀c"   // UTF-16: a, D83D DE00, b, D83D DE00, c
    let segs = PassageSegments.segments(text, [Highlight(start: 2, end: 3), Highlight(start: 3, end: 5), Highlight(start: 5, end: 99)])
    #expect(segs.map(\.text).joined() == text)
    // [2,3) widens to [1,3); [3,5) to [3,6); [5,99) to [4,7) and merges with it (overlap, not adjacency, merges).
    #expect(segs.filter(\.mark).map { [$0.start, $0.end] } == [[1, 3], [3, 7]])
    let none = PassageSegments.segments("abc", [Highlight(start: 2, end: 2), Highlight(start: 5, end: 9)])
    #expect(none.allSatisfy { !$0.mark })
  }

  @Test("the selected span marks the highlight covering it (pinned run vs newest run)")
  func selectedSpan() {
    let segs = PassageSegments.segments("Carry the zero, children", [Highlight(start: 0, end: 14, occ: 50077)], selectedOcc: 999,
                                        selectedSpan: 0..<14)
    #expect(segs.first { $0.mark }?.selected == true)
  }

  // MARK: Then (§2.D)

  @Test("contemporary window W = max(10 y, 2 × width), centred")
  func window() {
    #expect(ThenRules.contemporaryWindow((1994, 1994)) ?? (0, 0) == (1989, 1999))
    #expect(ThenRules.contemporaryWindow((1930, 1931)) ?? (0, 0) == (1925, 1936))   // floor(1925.5), ceil(1935.5)
    #expect(ThenRules.contemporaryWindow((1900, 1933)) ?? (0, 0) == (1882, 1951))
    #expect(ThenRules.contemporaryWindow(nil) == nil)
  }

  @Test("card years read by the date grammar; a trailing parenthesis is ignored")
  func cardYears() {
    #expect(ThenRules.cardYears("17 May 1994").map { [$0.lo, $0.hi] } == [1994, 1994])
    #expect(ThenRules.cardYears("1930–1931 (VS 1987)").map { [$0.lo, $0.hi] } == [1930, 1931])
    #expect(ThenRules.cardYears("") == nil)
  }

  @Test("uses: the passage itself dropped, ≤ 3 per lane, ≤ 9 in all, engine order kept")
  func stratify() {
    func row(_ p: Int64, _ lane: String) -> KwicRow {
      KwicRow(passage: PassageID(rawValue: p), doc: 1, start: 0, end: 1, left: "", match: "x", right: "", synthetic: true, lane: lane)
    }
    let rows = (1...6).map { row($0, "a") } + (7...12).map { row($0, "b") } + (13...20).map { row($0, "c") }
    let out = ThenRules.stratify(rows, exclude: PassageID(rawValue: 2))
    #expect(out.count == 9)
    #expect(!out.contains { $0.passage.rawValue == 2 })
    #expect(out.map(\.passage.rawValue) == [1, 3, 4, 7, 8, 9, 13, 14, 15])
    #expect(ThenRules.usesDenominator(total: 37, tokens: 6_100_000, from: 1925, to: 1945).hasPrefix("n = 37 in 1925–1945 · "))
    #expect(ThenRules.usesDenominator(total: nil, tokens: nil, from: 1925, to: 1945) == "n = — in 1925–1945")
  }

  // MARK: The transport (§4.6)

  @Test("Play steps by bin ends: 1925 → 1929 → 1939 at decades; back lands on the previous bin's end")
  func vantageSteps() {
    let d1925 = DayMath.dayFromYMD(1925, 12, 31)
    let e1929 = VantageSteps.stepBinEnd(.decades, d1925, 1)
    #expect(DayMath.ymdFromDay(e1929) == (1929, 12, 31))
    #expect(DayMath.ymdFromDay(VantageSteps.stepBinEnd(.decades, e1929, 1)) == (1939, 12, 31))
    #expect(DayMath.ymdFromDay(VantageSteps.stepBinEnd(.decades, d1925, -1)) == (1919, 12, 31))
    #expect(DayMath.ymdFromDay(VantageSteps.stepBinEnd(.years, d1925, 1)) == (1926, 12, 31))
    let m = VantageSteps.stepBinEnd(.months, DayMath.dayFromYMD(1925, 2, 10), 1)
    #expect(DayMath.ymdFromDay(m) == (1925, 2, 28))
  }

  @Test("the demo opens at decades, as of 1925; the open vantage reads 'open'")
  func transportLabels() {
    var s = ViewState.defaultState("demo")
    #expect(VantageSteps.tier(of: s) == .decades)
    #expect(VantageSteps.label(s) == "1925")
    s.vantage.day = ViewState.vantageOpenDay
    #expect(VantageSteps.label(s) == TransportCopy.open)
    s.tier = "L3"
    #expect(VantageSteps.tier(of: s) == .years)
  }

  // MARK: State restoration (§4.15)

  @Test("the UI snapshot survives encoding, routes and modes included; damaged text restores nothing")
  func restoration() throws {
    let snap = UIStateSnapshot(
      detent: .half, mode: .drawer(BinRef(lane: "community:classroom", strand: "12", tier: "L2", bin: 191)),
      path: [.compare(CompareSeed(SliceSeed(fromYear: 1994, toYear: 2026), SliceSeed(fromYear: 1955, toYear: 1985), viewHash: "#v=1&c=demo"))],
      tab: .then, readerOpen: true)
    let text = StateRestoration.encode(snap)
    #expect(!text.isEmpty)
    #expect(StateRestoration.decode(text) == snap)
    #expect(StateRestoration.decode("") == nil)
    #expect(StateRestoration.decode("{\"detent\":\"sideways\"}") == nil)
    if case .compare(let seed) = snap.path[0] { #expect(seed.a.fromYear == 1955) }   // A is always the earlier slice
    var s = ViewState.defaultState("demo")
    s.selection = ViewState.Selection(type: "passage", id: .number(901))
    #expect(StateRestoration.viewState(from: s.hash)?.hash == s.hash)
    #expect(StateRestoration.viewState(from: "") == nil)
  }

  @Test("a force quit restores from the mirror; a self-test and -freshState neither restore nor record")
  func restorationRules() {
    #expect(StateRestoration.pick(scene: "#v=1&c=demo&t=1939", mirror: "#v=1&c=cipher") == "#v=1&c=demo&t=1939")
    #expect(StateRestoration.pick(scene: "", mirror: "#v=1&c=cipher") == "#v=1&c=cipher")
    #expect(StateRestoration.pick(scene: "", mirror: nil) == "")
    #expect(StateRestoration.persists(LaunchArgs.parse(["app", "-ui-testing"]), arguments: ["app", "-ui-testing"]))
    #expect(!StateRestoration.persists(LaunchArgs.parse(["app", "-selftest", "first-minute"]), arguments: ["app", "-selftest", "first-minute"]))
    #expect(!StateRestoration.persists(LaunchArgs.parse(["app", "-ui-testing"]), arguments: ["app", "-ui-testing", "-freshState"]))
  }

  // MARK: Search (§4.9)

  @Test("every suggestion count names what it counts (§4.1 rule 6)")
  func countWords() {
    #expect(SearchCopy.countWords(type: "expression", count: 340, corpus: "Demo") == "340 matches · Demo")
    #expect(SearchCopy.countWords(type: "expression", count: 1, corpus: nil) == "1 match")
    #expect(SearchCopy.countWords(type: "theme", count: 47, corpus: "Demo") == "47 documents")
    #expect(SearchCopy.countWords(type: "maker", count: 1, corpus: "Demo") == "1 document")
    #expect(SearchCopy.countWords(type: "annotation", count: 2, corpus: nil) == "2 annotations")
    #expect(SearchCopy.countWords(type: "expression", count: 12_400, corpus: "Cipher") == "12,400 matches · Cipher")
  }

  @Test("suggestion actions: track new, pin tracked, works open Genealogy, sources, info")
  func actions() {
    func s(_ type: String, _ ref: String) -> SearchSuggestion { SearchSuggestion(type: type, label: "x", ref: ref, count: nil) }
    #expect(SuggestionAction.of(s("expression", "expression:new")) == .track)
    #expect(SuggestionAction.of(s("expression", "expression:12")) == .pin(type: "expression", id: .number(12)))
    #expect(SuggestionAction.of(s("work", "document:44")) == .genealogy(44))
    #expect(SuggestionAction.of(s("maker", "maker:mc-ledgerline")) == .pin(type: "maker", id: .string("mc-ledgerline")))
    #expect(SuggestionAction.of(s("theme", "theme:hip hop")) == .pin(type: "theme", id: .string("hip hop")))
    #expect(SuggestionAction.of(s("adapter", "adapters")) == .sources)
    #expect(SuggestionAction.of(s("etymology", "etymon:none")) == .info)
  }

  @Test("romanised matches: native forms only, script → language, never merged into the query's count")
  func romanised() {
    let q = SearchQuery(surface: "shunya", norm: "shunya", tokens: ["shunya"], kind: "word", variants: [
      SearchVariant(form: "shunyas", type: "inflection", rule: "en-inflect@1", status: "computed"),
      SearchVariant(form: "शून्य", type: "transliteration", rule: "translit-key@1", status: "computed", enabled: false),
      SearchVariant(form: "શૂન્ય", type: "transliteration", rule: "translit-key@1", status: "computed", enabled: false, n: 88),
    ])
    let r = SearchResponse(query: q, suggestions: [], expression: nil,
                           hits: SearchHits(passages: 0, documents: 0, undated: 0, namesExcluded: 0, preliminary: false),
                           kwic: [], titles: [], emptyNote: nil,
                           provenance: Provenance(dataVersion: 1, runIds: [:], tokenizer: "u61m-1", segmenter: "seg-1",
                                                  synthetic: false, collections: [], licenses: []))
    let m = RomanisedMatch.from(r)
    #expect(m.map(\.form) == ["शून्य", "શૂન્ય"])
    #expect(m.map(\.lang) == ["hi", "gu"])
    #expect(m[0].counting && m[0].count == nil)
    #expect(m[1].line == "શૂન્ય · Gujarati · 88 matches")
  }

  // MARK: Filters, coach words, haptics

  @Test("facet values cycle include → exclude → off; the evidence chips step all → documented+computed → documented")
  func filters() {
    #expect(FilterRules.cycle([], "book") == ["book"])
    #expect(FilterRules.cycle(["book"], "book") == ["-book"])
    #expect(FilterRules.cycle(["-book"], "book") == [])
    var e = ViewState.defaultState("demo").evidence
    #expect(FilterRules.evidenceStep(e) == "all")
    FilterRules.applyEvidence("dc", to: &e)
    #expect(FilterRules.evidenceStep(e) == "dc")
    FilterRules.applyEvidence("d", to: &e)
    #expect(e["computed"] == 0 && e["proposed"] == 0 && e["documented"] == 1)
  }

  @Test("coach words come from the data on screen; Cipher's line says what is ready")
  func coachWords() {
    let doc = Arc(relId: 7781, relType: "explicit_citation", family: "citation", evidenceStatus: "documented",
                  src: ArcEnd(passage: 901, y: 1994), dst: ArcEnd(passage: 77, y: 1911), feedback: false, synthetic: true)
    var calc = Arc(relId: 7790, relType: "exact_quotation", family: "quotation", evidenceStatus: "computed",
                   src: ArcEnd(passage: 1630, y: 1963), dst: ArcEnd(passage: 77, y: 1911), feedback: false, synthetic: true)
    calc.runId = 9
    let two = CoachWords.text(.second, label: nil, doc: doc, calc: calc, cipher: nil)
    #expect(two.lines[0] == "DOC — 1994 explicit citation → 1911: a documented record (synthetic)")
    #expect(two.lines[1] == "CALC — 1963 exact quotation → 1911: computed by text matching (run #9)")
    #expect(two.lines.last == TourCopy.lineStyle)
    #expect(CoachWords.text(.first, label: "carry the zero", doc: nil, calc: nil, cipher: nil).lines[0].contains("‘carry the zero’ was observed"))
    let full = BootstrapStatus(status: "fulltext", phase: "B", progress: 0.21, message: "full text 312 / 1,516 books")
    #expect(CoachWords.cipherLine(full) == "Cipher titles, relations and etymology ready · full text 312 / 1,516 books")
    #expect(CoachWords.cipherOpenable(full))
    let a = BootstrapStatus(status: "metadata", phase: "A", progress: 0.55)
    #expect(CoachWords.cipherLine(a) == "Cipher: importing titles & relations · 55%")
    #expect(!CoachWords.cipherOpenable(a))
  }

  @Test("the haptic map: transients only, and a gate card plays nothing")
  func haptics() {
    #expect(ScrollsHaptic.gateShown.tap == nil)
    #expect(ScrollsHaptic.allCases.count == 8)
    let engine = AppModel(launch: LaunchArgs.parse(["app", "-ui-testing"])).hapticEngine
    let map = HapticsMap(engine: engine)
    map.play(.gateShown)
    map.play(.select)
    #expect(map.log == [.gateShown, .select])
  }

  // MARK: The SheetMode machine over the contract fixtures

  @Test("a selection opens Then; a bin opens its drawer; clearing returns to idle")
  func sheetModes() async throws {
    let model = AppModel(launch: LaunchArgs.parse(["app", "-ui-testing"]))
    await model.start()
    let e = model.experience
    model.viewState.selection = ViewState.Selection(type: "occurrence", id: .number(55012))
    e.selectionChanged(model.viewState.selection)
    #expect(e.mode == .inspector(InspectedRef(type: "occurrence", id: 55012)))
    #expect(model.coordinator.inspectorDetent == .half)
    // The occurrence resolves to its passage through the engine (MockAtlas: passage 901), never by guessing.
    for _ in 0..<100 where e.then.passage.value == nil { try await Task.sleep(for: .milliseconds(50)) }
    let p = try #require(e.then.passage.value)
    #expect(p.id == 901)
    #expect(e.then.selectedOcc == 55012)
    for _ in 0..<100 where e.then.uses.value == nil && e.then.usesAbsence == nil { try await Task.sleep(for: .milliseconds(50)) }
    let uses = try #require(e.then.uses.value)
    #expect(uses.from == 1989 && uses.to == 1999)
    #expect(uses.rows.count <= ThenRules.usesMax)

    let bin = BinRef(lane: "community:classroom", strand: "12", tier: "L2", bin: 191)
    model.viewState.selection = bin.selection
    e.selectionChanged(model.viewState.selection)
    #expect(e.mode == .drawer(bin))
    for _ in 0..<100 where e.list.state.value == nil { try await Task.sleep(for: .milliseconds(50)) }
    #expect(e.list.denominatorLine.hasPrefix("n = 22 in 1910–1919"))
    #expect(e.list.kwicRows.count == 3)
    #expect(e.list.denominatorSynthetic)

    model.viewState.selection = nil
    e.selectionChanged(nil)
    #expect(e.mode == .idle)
  }

  @Test("pinning: at most four strands, glyphs follow position, unpinning reassigns them")
  func pinning() {
    let model = AppModel(launch: LaunchArgs.parse(["app", "-ui-testing"]))
    let e = model.experience
    for i in 1...5 { e.pin(type: "expression", id: .number(i), label: "w\(i)", quiet: true) }
    #expect(model.viewState.strands.count == ViewState.maxStrands)
    #expect(model.banner == SearchCopy.maxStrands)
    #expect(model.viewState.strands.map(\.glyph) == ["circle", "square", "triangle", "diamond"])
    e.unpin(at: 0)
    #expect(model.viewState.strands.map(\.id) == [.number(2), .number(3), .number(4)])
    #expect(model.viewState.strands.map(\.glyph) == ["circle", "square", "triangle"])
  }
}
