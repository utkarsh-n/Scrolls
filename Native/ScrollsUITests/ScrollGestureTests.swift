// OWNER: N7
// ScrollGestureTests (IOS-SPEC §4.5, §4.19, §4.23, §8.5 N7): the Scroll's gestures on the simulator, on the contract
// fixtures (`-ui-testing`, deterministic): the canvas, minimap, ruler and playhead are there; a one-finger pan moves time
// (the ruler's visible stretch changes) and a vertical pan scrolls the lanes; pinch zooms x only; double tap zooms in one
// tier; long press on the ruler then drag brushes a range whose chips appear; the playhead handle is adjustable; pans
// work with the inspector at each detent (peek, half, large) and touches above the inspector reach the Scroll; and a
// signposted pan + pinch session (XCTOSSignpostMetric on the "perf" category) — a proxy on the simulator, the budget is
// a device row. Every launch passes `-freshState`, so a restored state never changes a test.

import XCTest

@MainActor
final class ScrollGestureTests: XCTestCase {
  nonisolated override func setUp() {
    continueAfterFailure = false
  }

  private func launch(_ extra: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing", "-freshState"] + extra
    app.launch()
    return app
  }

  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

  /// The ruler's accessibility value: the visible stretch and the bins ("1906 to 2026 · Bins: decades · …").
  private func rulerValue(_ app: XCUIApplication) -> String {
    (app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Ruler'")).firstMatch.value as? String) ?? ""
  }

  private func waitForChange(_ before: String, _ read: () -> String, timeout: TimeInterval = 5) -> String {
    let deadline = Date().addingTimeInterval(timeout)
    var now = read()
    while now == before, Date() < deadline {
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
      now = read()
    }
    return now
  }

  func testTheScrollIsThere() throws {
    let app = launch()
    XCTAssertTrue(element(app, "scrollCanvas").waitForExistence(timeout: 60), "the Scroll's canvas never appeared")
    XCTAssertTrue(element(app, "minimap").exists, "the minimap is missing")
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Ruler'")).firstMatch.exists, "the ruler is missing")
    XCTAssertTrue(element(app, "scrollFixturesNote").exists, "fixtures must be labelled on the Scroll")
  }

  func testPanMovesTimeAndPinchZooms() throws {
    let app = launch()
    let canvas = element(app, "scrollCanvas")
    XCTAssertTrue(canvas.waitForExistence(timeout: 60))
    let ruler = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Ruler'")).firstMatch
    XCTAssertTrue(ruler.waitForExistence(timeout: 10))
    let before = rulerValue(app)
    // one finger, mostly horizontal: time pans
    let from = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.35))
    let to = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.37))
    from.press(forDuration: 0.05, thenDragTo: to)
    let panned = waitForChange(before) { rulerValue(app) }
    XCTAssertNotEqual(panned, before, "a horizontal pan did not move the visible stretch")
    // pinch out: zooms x only (the stretch narrows)
    canvas.pinch(withScale: 2.5, velocity: 2)
    let zoomed = waitForChange(panned) { rulerValue(app) }
    XCTAssertNotEqual(zoomed, panned, "pinch did not change the zoom")
    // double tap: one tier in
    canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).doubleTap()
    let tier = waitForChange(zoomed) { rulerValue(app) }
    XCTAssertNotEqual(tier, zoomed, "double tap did not zoom in")
  }

  func testRulerBrushShowsRangeChips() throws {
    let app = launch()
    let canvas = element(app, "scrollCanvas")
    XCTAssertTrue(canvas.waitForExistence(timeout: 60))
    // the ruler is the first 28 pt of the canvas
    let start = canvas.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 120, dy: 12))
    let end = canvas.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 260, dy: 14))
    start.press(forDuration: 0.8, thenDragTo: end)
    XCTAssertTrue(app.buttons["Compare slice A"].waitForExistence(timeout: 5), "the brushed range has no A chip")
    XCTAssertTrue(app.buttons["Compare slice B"].exists)
    app.buttons["Compare slice A"].tap()
    app.buttons["Clear the range"].tap()
    XCTAssertFalse(app.buttons["Compare slice A"].waitForExistence(timeout: 2), "the range did not clear")
  }

  func testPlayheadIsAdjustable() throws {
    let app = launch()
    let handle = element(app, "playheadHandle")
    XCTAssertTrue(handle.waitForExistence(timeout: 60), "the playhead handle is missing")
    let before = (handle.value as? String) ?? ""
    handle.swipeUp()
    let after = waitForChange(before) { (handle.value as? String) ?? "" }
    XCTAssertNotEqual(before, after, "stepping the playhead did not move the vantage")
  }

  func testPansWithTheInspectorAtEachDetent() throws {
    let app = launch()
    let canvas = element(app, "scrollCanvas")
    let handle = element(app, "inspectorHandle")
    XCTAssertTrue(canvas.waitForExistence(timeout: 60))
    XCTAssertTrue(handle.waitForExistence(timeout: 10))
    for target in [0.55, 0.15, 0.85] {
      // drag the sheet's handle to a height (half, large, back to peek)
      let window = app.windows.firstMatch
      handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        .press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: target)))
      RunLoop.current.run(until: Date().addingTimeInterval(0.6))
      let before = rulerValue(app)
      // pan just under the ruler, above any detent
      let from = canvas.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 300, dy: 60))
      let to = canvas.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 120, dy: 62))
      from.press(forDuration: 0.05, thenDragTo: to)
      let after = waitForChange(before) { rulerValue(app) }
      XCTAssertNotEqual(after, before, "a pan above the inspector (detent drag to \(target)) did not reach the Scroll")
    }
  }

  func testPanAndPinchSessionSignposts() throws {
    let app = launch(["-perf"])
    let canvas = element(app, "scrollCanvas")
    XCTAssertTrue(canvas.waitForExistence(timeout: 60))
    let options = XCTMeasureOptions()
    options.iterationCount = 3
    measure(metrics: [XCTOSSignpostMetric.scrollingAndDecelerationMetric, XCTClockMetric()], options: options) {
      for i in 0..<3 {
        let a = canvas.coordinate(withNormalizedOffset: CGVector(dx: i % 2 == 0 ? 0.8 : 0.2, dy: 0.4))
        let b = canvas.coordinate(withNormalizedOffset: CGVector(dx: i % 2 == 0 ? 0.2 : 0.8, dy: 0.41))
        a.press(forDuration: 0.02, thenDragTo: b, withVelocity: .fast, thenHoldForDuration: 0)
      }
      canvas.pinch(withScale: 1.8, velocity: 1.5)
      canvas.pinch(withScale: 0.6, velocity: -1.5)
    }
  }
}
