// OWNER: N8
// FirstMinuteTests (IOS-SPEC §4.17, §8.5 N8): the first-minute script on the simulator, on the contract fixtures
// (`-ui-testing`, deterministic). The demo opens with the SYNTHETIC ribbon; coach ① arrives ≈ 2 s after the Scroll, ②
// and ③ follow, Play runs the vantage through the decades, and Your turn offers Switch to Cipher (enabled: the fixture
// health reports Cipher's phase A done). The coach marks never block: the field and the transport stay usable while a
// card is up; a dismissed card never returns unless he asks for the Tour. Timings are written to the log as
// `FIRSTMINUTE {json}` (Tools/check.d/app.sh collects them); on the simulator they are proxies, never device numbers.
// Every launch passes `-freshState`, so a state restored from an earlier test never changes the script.

import XCTest

@MainActor
final class FirstMinuteTests: XCTestCase {
  private var timings: [String: Double] = [:]

  nonisolated override func setUp() {
    continueAfterFailure = false
  }

  /// Prints and attaches the timings (each test calls it on the way out).
  private func report() {
    guard !timings.isEmpty, let data = try? JSONSerialization.data(withJSONObject: timings, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { return }
    print("FIRSTMINUTE \(name) \(text)")
    let a = XCTAttachment(string: text)
    a.name = "first-minute timings"
    a.lifetime = .keepAlways
    add(a)
  }

  /// Waits for a predicate on an element without an expectation on the test case.
  private func waitFor(_ predicate: NSPredicate, _ element: XCUIElement, timeout: TimeInterval) -> Bool {
    XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: timeout) == .completed
  }

  private func launch(_ args: [String]) -> (XCUIApplication, Date) {
    let app = XCUIApplication()
    app.launchArguments = args
    let t0 = Date()
    app.launch()
    return (app, t0)
  }

  private func since(_ t0: Date) -> Double { (Date().timeIntervalSince(t0) * 100).rounded() / 100 }

  /// The whole script, stepped with Next and Play (the order and the words, quickly).
  func testFirstMinuteScript() throws {
    defer { report() }
    let (app, t0) = launch(["-ui-testing", "-freshState"])
    XCTAssertTrue(app.descendants(matching: .any)["corpusChip"].waitForExistence(timeout: 60), "the TopBar never appeared")
    timings["topbar_s"] = since(t0)
    XCTAssertTrue(app.descendants(matching: .any)["syntheticRibbon"].exists, "the SYNTHETIC ribbon must show on the demo")

    let one = app.descendants(matching: .any)["coach.1"]
    XCTAssertTrue(one.waitForExistence(timeout: 30), "coach ① never appeared")
    timings["coach1_s"] = since(t0)
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'was observed'")).firstMatch.exists)
    // Never blocking: the transport and the sheet's handle stay hittable while the card is up.
    XCTAssertTrue(app.descendants(matching: .any)["play"].isHittable)
    XCTAssertTrue(app.descendants(matching: .any)["inspectorHandle"].isHittable)

    app.buttons["coachNext"].tap()
    let two = app.descendants(matching: .any)["coach.2"]
    XCTAssertTrue(two.waitForExistence(timeout: 10), "coach ② never appeared")
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Line style = evidence'")).firstMatch.waitForExistence(timeout: 5))
    // ② names the arcs from the data: the documented one first.
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'DOC — 1994'")).firstMatch.waitForExistence(timeout: 10),
                  "coach ② should name the documented 1994 → 1911 arc from the arcs fixture")

    app.buttons["coachNext"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["coach.3"].waitForExistence(timeout: 10), "coach ③ never appeared")
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Press ▶'")).firstMatch.exists)

    let asOf = app.buttons["asOf"]
    XCTAssertTrue(asOf.label.contains("1925"), "the demo opens as of 1925, got \(asOf.label)")
    let tPlay = Date()
    app.descendants(matching: .any)["play"].tap()
    XCTAssertTrue(waitFor(NSPredicate(format: "label != %@", asOf.label), asOf, timeout: 10), "Play did not move the vantage")
    timings["first_step_s"] = since(tPlay)

    let yourTurn = app.descendants(matching: .any)["yourTurn"]
    XCTAssertTrue(yourTurn.waitForExistence(timeout: 40), "Your turn never appeared after Play")
    timings["play_to_your_turn_s"] = since(tPlay)
    XCTAssertTrue(asOf.label.contains("2026") || asOf.label.contains("202"), "Play should reach the 2020s, got \(asOf.label)")
    let cipher = app.buttons["switchToCipher"]
    XCTAssertTrue(cipher.waitForExistence(timeout: 5))
    XCTAssertTrue(cipher.isEnabled, "Switch to Cipher should be enabled: the fixture's phase A is done")
    XCTAssertTrue(app.buttons["fullTour"].exists)

    cipher.tap()
    let chip = app.buttons["corpusChip"]
    XCTAssertTrue(waitFor(NSPredicate(format: "value CONTAINS 'Cipher'"), chip, timeout: 10), "the corpus did not switch to Cipher")
    XCTAssertFalse(app.descendants(matching: .any)["syntheticRibbon"].exists, "Cipher is real data: no ribbon")
  }

  /// The untouched script: no taps, the schedule alone (① ≈ 2 s, ② ≈ 12 s, ③ ≈ 40 s, Your turn by ≈ 60 s).
  func testUntouchedScheduleTimings() throws {
    defer { report() }
    let (app, t0) = launch(["-ui-testing", "-freshState"])
    XCTAssertTrue(app.descendants(matching: .any)["corpusChip"].waitForExistence(timeout: 60))
    let ready = since(t0)
    timings["topbar_s"] = ready
    var last = ready
    for (stage, budget) in [("coach.1", 20.0), ("coach.2", 30.0), ("coach.3", 45.0), ("yourTurn", 40.0)] {
      XCTAssertTrue(app.descendants(matching: .any)[stage].waitForExistence(timeout: budget), "\(stage) never appeared")
      let t = since(t0)
      timings["\(stage)_s"] = t
      XCTAssertGreaterThanOrEqual(t, last, "\(stage) out of order")
      last = t
    }
    // Relative to the TopBar (the Scroll is up): ① ≈ 2 s, Your turn ≤ 60 s, with slack for the simulator's load.
    XCTAssertLessThan((timings["coach.1_s"] ?? 99) - ready, 8, "coach ① should come ≈ 2 s after the Scroll")
    XCTAssertLessThan((timings["yourTurn_s"] ?? 999) - ready, 75, "Your turn should come by ≈ 60 s")
  }

  /// A coach card never takes the screen: the search field focuses and searches while ① is up.
  func testCoachMarksNeverBlock() throws {
    let (app, _) = launch(["-ui-testing", "-freshState"])
    XCTAssertTrue(app.descendants(matching: .any)["coach.1"].waitForExistence(timeout: 60))
    let field = app.textFields["searchField"]
    XCTAssertTrue(field.isHittable)
    field.tap()
    field.typeText("zero")
    XCTAssertTrue(app.buttons["searchCancel"].waitForExistence(timeout: 10), "focusing the field raises the inspector to large")
    XCTAssertTrue(app.descendants(matching: .any)["searchHits"].waitForExistence(timeout: 20), "search results never arrived")
    XCTAssertTrue(app.descendants(matching: .any)["searchGroup.expressions"].exists)
  }

  /// `-tourStep 3` opens on coach ③; × ends the coach marks.
  func testTourStepAndDismiss() throws {
    let (app, _) = launch(["-ui-testing", "-freshState", "-tourStep", "3"])
    XCTAssertTrue(app.descendants(matching: .any)["coach.3"].waitForExistence(timeout: 60))
    app.buttons["coachDismiss"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["coach.3"].waitForNonExistence(timeout: 5))
    XCTAssertFalse(app.descendants(matching: .any)["yourTurn"].waitForExistence(timeout: 3), "a dismissed tour never comes back by itself")
  }

  /// A passage opens Then at half: from the search's passages (the 1911 primer), then the 1994 Hip-hop mark through a
  /// link (`scrolls://open#…&sel=occ:55012`, what a tap on the mark selects): its date chip, SYN, "refers to 1911".
  func testPassageOpensThen() throws {
    let (app, _) = launch(["-ui-testing", "-freshState", "-tourStep", "0"])   // -tourStep 0: no coach marks
    XCTAssertTrue(app.descendants(matching: .any)["corpusChip"].waitForExistence(timeout: 60))
    let field = app.textFields["searchField"]
    field.tap()
    field.typeText("carry the zero")
    let row = app.buttons["kwic.77"]
    XCTAssertTrue(row.waitForExistence(timeout: 20), "the 1911 primer is among the search's passages")
    row.tap()
    XCTAssertTrue(app.descendants(matching: .any)["passageCard"].waitForExistence(timeout: 20), "Then never opened")
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Brennock'")).firstMatch.exists)
    XCTAssertTrue(app.descendants(matching: .any)["thenFooter"].exists)

    let link = try XCTUnwrap(URL(string: "scrolls://open#v=1&c=demo&s=e12&sel=occ:55012"))
    app.open(link)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    if springboard.buttons["Open"].waitForExistence(timeout: 3) { springboard.buttons["Open"].tap() }
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'refers to 1911'")).firstMatch.waitForExistence(timeout: 20),
                  "the 1994 mark's passage (901) should say it refers to 1911")
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS '17 May 1994'")).firstMatch.exists)
    XCTAssertTrue(app.descendants(matching: .any)["usesDenominator"].waitForExistence(timeout: 20),
                  "contemporary uses come with their denominator line")
  }
}
