// OWNER: N8
// StateRestorationTests (IOS-SPEC §4.15, N-23): background the app, terminate it, relaunch, and compare. The view-state
// hash (`@SceneStorage("view")`: vantage, mode, strands, selection …), the sheet's detent and mode, and the pushed route
// (`@SceneStorage("ui")`) come back. Under `-ui-testing` one invisible element (`debug.viewState`) carries
// "hash|mode|detent", so the comparison is exact.

import XCTest

@MainActor
final class StateRestorationTests: XCTestCase {
  nonisolated override func setUp() {
    continueAfterFailure = false
  }

  /// `fresh`: start from the corpus default (`-freshState` clears what an earlier test left); the relaunch is not fresh.
  private func launch(fresh: Bool) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-ui-testing", "-tourStep", "0"] + (fresh ? ["-freshState"] : [])   // -tourStep 0: no coach marks
    app.launch()
    return app
  }

  private func probe(_ app: XCUIApplication) -> String {
    let e = app.descendants(matching: .any)["debug.viewState"]
    XCTAssertTrue(e.waitForExistence(timeout: 60), "the debug state probe is missing")
    return (e.value as? String) ?? ""
  }

  /// Background → terminate → relaunch: the hash, the mode and the detent are restored.
  func testStateRestoredAfterKill() throws {
    var app = launch(fresh: true)
    XCTAssertTrue(app.descendants(matching: .any)["corpusChip"].waitForExistence(timeout: 60))
    // Change the state: two steps of the vantage, context → strict, and the sheet to half.
    app.buttons["step"].tap()
    app.buttons["step"].tap()
    app.buttons["vantageMode"].tap()
    app.descendants(matching: .any)["inspectorHandle"].tap()
    let before = probe(app)
    XCTAssertTrue(before.contains("t="), "the vantage moved, so the hash carries it: \(before)")
    XCTAssertTrue(before.hasSuffix("|half"), "the sheet is at half: \(before)")

    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 3)
    app.terminate()
    app = launch(fresh: false)
    XCTAssertTrue(app.descendants(matching: .any)["corpusChip"].waitForExistence(timeout: 60))
    let after = probe(app)
    XCTAssertEqual(after, before, "state after the kill differs")
  }

  /// A pushed destination (Compare, from More) is restored on its route.
  func testPushedRouteRestored() throws {
    var app = launch(fresh: true)
    XCTAssertTrue(app.descendants(matching: .any)["corpusChip"].waitForExistence(timeout: 60))
    app.buttons["moreMenu"].tap()
    app.buttons["Compare"].tap()
    let compare = app.descendants(matching: .any)["notBuilt.Compare"]
    let compareBuilt = app.navigationBars.firstMatch
    XCTAssertTrue(compare.waitForExistence(timeout: 10) || compareBuilt.waitForExistence(timeout: 1), "Compare was not pushed")
    let pushedBefore = compare.exists
    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 3)
    app.terminate()
    app = launch(fresh: false)
    if pushedBefore {
      XCTAssertTrue(app.descendants(matching: .any)["notBuilt.Compare"].waitForExistence(timeout: 60), "the pushed Compare route was not restored")
    } else {
      XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 60), "the pushed Compare route was not restored")
    }
  }
}
